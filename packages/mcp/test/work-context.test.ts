import { join } from "node:path";

import { expect, it } from "vitest";
import {
  addComment, addRepository, associateRepository, createIssue, createProject, getWorkContext, moveIssue, previewRun, startRun, updateIssue,
  type RepositoryInspector
} from "@issue-tracker/core";

import { agentFixture } from "./agent-fixture.js";

const inspector: RepositoryInspector = {
  inspect: (path, baseRef) => ({ canonicalPath: path, commonDir: `${path}/.git`, defaultBranch: baseRef ?? "main", headCommit: "b".repeat(40), dirty: false, instructionFiles: [], instructions: {} })
};
const command = { executable: "node", args: ["--test"], envNames: [] };

it("serves the core work context over MCP and CLI identically, live and from a run snapshot", async () => {
  const f = await agentFixture();
  try {
    const project = createProject(f.context, { name: "Fictional Delivery" });
    createIssue(f.context, { title: "Set up CI", projectId: project.id, description: "Pipeline work.\n\nDone when:\n- CI runs on every push\n- Failures block merge" });
    createIssue(f.context, { title: "Provision fictional runners" });
    updateIssue(f.context, "ENG-1", { blockedBy: ["ENG-2"] });
    addComment(f.context, { issue: "ENG-1", body: "Decision: use the fictional runner pool" });
    const repository = addRepository(f.context, { name: "Pipeline", path: join(f.dbPath, "..", "pipeline"), testCommand: command, verificationCommand: command }, inspector);
    associateRepository(f.context, { repository: repository.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });

    const live = await f.call("get_work_context", { identifier: "ENG-1" });
    expect(live.error).toBe(false);
    expect(live.data).toEqual(getWorkContext(f.context, { identifier: "ENG-1" }));
    expect(live.data).toMatchObject({ mode: "live", runId: null, staleness: null });
    expect(live.data.context.sections.acceptanceCriteria.items).toEqual(["CI runs on every push", "Failures block merge"]);
    expect(live.data.context.sections.decisions.items[0].body).toBe("Decision: use the fictional runner pool");
    expect(live.data.context.sections.repositories).toMatchObject({ status: "resolved", primaryRepositoryId: repository.id });
    expect(JSON.parse(f.cli(["issue", "context", "ENG-1", "--json"]))).toEqual(live.data);
    const bounded = await f.call("get_work_context", { identifier: "ENG-1", maxBytes: 4096 });
    expect(JSON.parse(f.cli(["issue", "context", "ENG-1", "--max-bytes", "4096", "--json"]))).toEqual(bounded.data);

    const runtime = { inspector, dataRoot: join(f.dbPath, "..", "data") };
    const preview = previewRun(f.context, { issue: "ENG-1" }, runtime);
    const run = startRun(f.context, { issue: "ENG-1", previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
    moveIssue(f.context, "ENG-2", "Done");
    const snapshot = await f.call("get_work_context", { identifier: "ENG-1", run: run.id });
    expect(snapshot.error).toBe(false);
    expect(snapshot.data.context).toEqual(live.data.context);
    expect(snapshot.data.context.sections.blockers.items[0]).toMatchObject({ identifier: "ENG-2", resolved: false });
    expect(snapshot.data.staleness).toEqual({ stale: true, omittedChangeCount: 0, changes: [expect.objectContaining({ kind: "blocker", identifier: "ENG-2", change: "changed" })] });
    expect((await f.call("get_work_context", { identifier: "ENG-1" })).data.context.sections.blockers.items[0].resolved).toBe(true);
    expect(JSON.parse(f.cli(["issue", "context", "ENG-1", "--run", run.id, "--json"]))).toEqual(snapshot.data);

    const rejected = await f.call("get_work_context", { identifier: "ENG-1", run: run.id, maxBytes: 8192 });
    expect(rejected.error).toBe(true);
    expect(rejected.data.error.code).toBe("VALIDATION_FAILED");
    expect(f.cliError(["issue", "context", "ENG-1", "--run", run.id, "--max-bytes", "8192", "--json"]).code).toBe("VALIDATION_FAILED");
    expect((await f.call("get_work_context", { identifier: "ENG-9" })).data.error.code).toBe("ISSUE_NOT_FOUND");
  } finally { await f.close(); }
});
