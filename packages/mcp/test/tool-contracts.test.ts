import { builtinProfileInput, toolContract, toolContractNames, toolProfileSchema } from "@issue-tracker/core";
import { describe, expect, it } from "vitest";

import { agentFixture } from "./agent-fixture.js";
import { contractFixture, type AuditEntry } from "./contract-fixture.js";
import { readScenarios, undrivableTools, writeScenarios } from "./tool-scenarios.js";

/** UPDATEs a non-destructive tool may perform: bookkeeping only (revision triggers, touch, team counter). */
const BOOKKEEPING: Record<string, string[]> = {
  issues: ["revision", "updated_at"],
  teams: ["issue_counter"]
};

const OPEN_WORLD = ["nudge_run", "publish_run", "resume_run", "retry_run", "start_run"];

/**
 * The documented no-write conflict a repeat returns for an idempotent tool whose first call already
 * moved the record out of the state it acts on. Every other idempotent repeat must succeed.
 */
const REPEAT_CONFLICT: Record<string, string> = {
  archive_project: "CONSTRAINT_VIOLATION",
  archive_repository: "CONSTRAINT_VIOLATION",
  archive_team: "CONSTRAINT_VIOLATION",
  claim_issue: "ISSUE_ALREADY_CLAIMED",
  delete_saved_view: "SAVED_VIEW_NOT_FOUND",
  delete_template: "TEMPLATE_NOT_FOUND",
  unarchive_issue: "CONSTRAINT_VIOLATION",
  unarchive_label: "CONSTRAINT_VIOLATION",
  unarchive_project: "CONSTRAINT_VIOLATION",
  unarchive_team: "CONSTRAINT_VIOLATION"
};

function nonBookkeeping(audit: AuditEntry[]): AuditEntry[] {
  return audit.filter((entry) => entry.op === "DELETE" || entry.changed.some((column) => !(BOOKKEEPING[entry.table] ?? []).includes(column)));
}

describe("tool catalog", () => {
  it("advertises core-owned annotations and output schemas for every registered tool in every profile", async () => {
    const names = toolContractNames();
    expect(names).toHaveLength(77);
    expect(names).toEqual(expect.arrayContaining(["whoami", "get_current_actor", "list_run_events", "get_work_context"]));

    for (const profile of toolProfileSchema.options) {
      const f = await agentFixture({ toolProfile: profile });
      try {
        const { tools } = await f.client.listTools();
        expect(tools.length, profile).toBeGreaterThan(0);
        for (const tool of tools) {
          const contract = toolContract(tool.name);
          expect(tool.annotations, tool.name).toEqual(contract.annotations);
          expect(tool.title, tool.name).toBe(contract.annotations.title);
          expect(tool.outputSchema !== undefined, tool.name).toBe(contract.structured);
          if (tool.outputSchema) expect(tool.outputSchema.type, tool.name).toBe("object");
        }
        if (profile === "full") expect(tools.map((tool) => tool.name).sort()).toEqual(names);
      } finally { await f.close(); }
    }
  });

  it("keeps hint combinations coherent", () => {
    for (const name of toolContractNames()) {
      const { annotations, structured, outputSchema, responseSchema } = toolContract(name);
      if (annotations.readOnlyHint) {
        expect(annotations, name).not.toHaveProperty("destructiveHint");
        expect(annotations, name).not.toHaveProperty("idempotentHint");
      } else {
        expect(typeof annotations.destructiveHint, name).toBe("boolean");
        expect(typeof annotations.idempotentHint, name).toBe("boolean");
      }
      expect(annotations.openWorldHint, name).toBe(OPEN_WORLD.includes(name));
      expect(outputSchema !== undefined, name).toBe(structured);
      if (!name.endsWith("_engine") && !name.endsWith("_engines")) expect(responseSchema, name).toBeDefined();
    }
    expect(() => toolContract("drop_database")).toThrow(expect.objectContaining({ code: "TOOL_CONTRACT_VIOLATION", message: expect.stringMatching(/No tool contract/) }));
  });
});

describe("hints match behavior", () => {
  it("covers every tool with a driven scenario or a documented gap", () => {
    const driven = new Set([...readScenarios, ...writeScenarios].map((scenario) => scenario.tool));
    for (const name of toolContractNames()) {
      expect(driven.has(name) || undrivableTools.includes(name), name).toBe(true);
    }
    for (const name of undrivableTools) {
      expect(toolContract(name).annotations.readOnlyHint, name).toBe(false);
      expect(toolContract(name).annotations.idempotentHint, name).toBe(false);
    }
    // Every positive hint is exercised by the harness below.
    for (const name of toolContractNames()) {
      const { annotations } = toolContract(name);
      if (annotations.readOnlyHint) expect(readScenarios.some((scenario) => scenario.tool === name), name).toBe(true);
      if (annotations.idempotentHint || annotations.destructiveHint === false) {
        expect(writeScenarios.some((scenario) => scenario.tool === name), name).toBe(true);
      }
    }
  });

  it("read-only tools write nothing and never provision an unknown caller", async () => {
    const f = await contractFixture();
    try {
      const handles = f.actorHandles();
      for (const scenario of readScenarios) {
        expect(toolContract(scenario.tool).annotations.readOnlyHint, scenario.tool).toBe(true);
        const before = f.snapshot();
        const result = await f.read(scenario.tool, scenario.args(f.seed, f));
        expect(result.isError, `${scenario.tool} ${scenario.label ?? ""}: ${result.text}`).toBe(false);
        expect(f.snapshot(), `${scenario.tool} ${scenario.label ?? ""}`).toEqual(before);
      }
      expect(f.actorHandles()).toEqual(handles);
      expect(handles).not.toContain("fictional-unknown-reader");

      // A caller-sensitive read with no resolved actor answers as it does without an actor handle.
      const mine = await f.read("list_issues", { view: "builtin:my-open" });
      expect((mine.data as { issues: Array<{ identifier: string }> }).issues.map((issue) => issue.identifier)).toEqual(["ENG-1"]);

      // Only non-read-only tools provision the caller.
      const whoami = await f.read("whoami", {});
      expect(whoami.isError).toBe(false);
      expect(f.actorHandles()).toContain("fictional-unknown-reader");
    } finally { await f.close(); }
  });

  it("issue resources read through an unknown agent handle without provisioning it", async () => {
    const f = await contractFixture();
    try {
      const before = f.snapshot();
      const issue = await f.reader.readResource({ uri: "issue://ENG-1" });
      const backlog = await f.reader.readResource({ uri: "backlog://ENG" });
      expect(JSON.parse((issue.contents[0] as { text: string }).text)).toMatchObject({ identifier: "ENG-1" });
      expect(JSON.parse((backlog.contents[0] as { text: string }).text).issues.length).toBeGreaterThan(0);
      expect(f.snapshot()).toEqual(before);
      expect(f.actorHandles()).not.toContain("fictional-unknown-reader");
    } finally { await f.close(); }
  });

  it("an unknown human handle is rejected on reads and writes alike; an unknown agent reads without provisioning", async () => {
    const f = await contractFixture();
    try {
      const human = await f.connect({ handle: "fictional-ghost", type: "human" });
      for (const [tool, args] of [["list_issues", {}], ["get_issue", { identifier: "ENG-1" }], ["create_label", { name: "Ghostly" }]] as const) {
        const result = await f.call(human, tool, args);
        expect(result.isError, tool).toBe(true);
        expect((result.data as { error: { code: string } }).error.code, tool).toBe("ACTOR_NOT_FOUND");
      }
      await expect(human.readResource({ uri: "issue://ENG-1" })).rejects.toThrow(/fictional-ghost was not found/);
      expect(f.actorHandles()).not.toContain("fictional-ghost");

      const agent = await f.connect({ handle: "fictional-newcomer" });
      expect((await f.call(agent, "list_issues", {})).isError).toBe(false);
      expect(f.actorHandles()).not.toContain("fictional-newcomer");
      expect((await f.call(agent, "create_label", { name: "Newcomer" })).isError).toBe(false);
      expect(f.actorHandles()).toContain("fictional-newcomer");
    } finally { await f.close(); }
  });

  it("idempotent tools do nothing on repeat and non-destructive tools only add rows", async () => {
    const f = await contractFixture();
    try {
      for (const scenario of writeScenarios) {
        const { annotations } = toolContract(scenario.tool);
        const name = `${scenario.tool} ${scenario.label ?? ""}`;
        f.drainAudit();
        const first = await f.write(scenario.tool, scenario.args(f.seed, f));
        expect(first.isError, `${name}: ${first.text}`).toBe(false);
        const audit = f.drainAudit();

        if (annotations.destructiveHint === false) {
          expect(nonBookkeeping(audit), name).toEqual([]);
        }

        if (annotations.idempotentHint === true) {
          const settled = f.snapshot();
          const repeat = await f.write(scenario.tool, scenario.args(f.seed, f));
          const expectedConflict = REPEAT_CONFLICT[scenario.tool];
          if (expectedConflict) {
            expect(repeat.isError, `${name}: ${repeat.text}`).toBe(true);
            expect((repeat.data as { error: { code: string } }).error.code, name).toBe(expectedConflict);
          } else {
            expect(repeat.isError, `${name}: ${repeat.text}`).toBe(false);
          }
          expect(f.snapshot(), name).toEqual(settled);
          f.drainAudit();
        }
      }
    } finally { await f.close(); }
  });

  it("false hints are backed by observable counterexamples", async () => {
    const f = await contractFixture();
    try {
      // create_issue is not idempotent: a key-less repeat files another issue.
      const first = await f.write("create_issue", { title: "Fictional retro", response: "compact" });
      const second = await f.write("create_issue", { title: "Fictional retro", response: "compact" });
      expect([first.data, second.data].map((data) => (data as { identifier: string }).identifier)).toEqual(["ENG-6", "ENG-7"]);

      // Destructive: a default profile clears isDefault elsewhere; association replaces its row.
      f.drainAudit();
      await f.write("add_orchestration_profile", { name: "Fictional Default", configuration: builtinProfileInput().configuration, isDefault: true });
      expect(f.drainAudit()).toContainEqual({ table: "orchestration_profiles", op: "UPDATE", changed: ["is_default"] });
      await f.write("associate_repository", { repository: "Primary", project: "Fictional Delivery" });
      expect(f.drainAudit().some((entry) => entry.table === "project_repositories" && entry.op === "DELETE")).toBe(true);
      // Profile defaults and archival re-stamp updatedAt on every call.
      for (const [tool, profile] of [["set_default_orchestration_profile", "Fictional Review"], ["archive_orchestration_profile", "Fictional Review"]] as const) {
        const once = await f.write(tool, { profile });
        const twice = await f.write(tool, { profile });
        expect(once.isError || twice.isError, tool).toBe(false);
        expect((twice.data as { updatedAt: string }).updatedAt, tool).not.toBe((once.data as { updatedAt: string }).updatedAt);
      }

      // archive_run re-stamps too.
      const archived = await f.write("archive_run", { run: f.seed.archivable, view: "summary" });
      const rearchived = await f.write("archive_run", { run: f.seed.archivable, view: "summary" });
      expect((rearchived.data as { updatedAt: string }).updatedAt).not.toBe((archived.data as { updatedAt: string }).updatedAt);

    } finally { await f.close(); }
  });
});
