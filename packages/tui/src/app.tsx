import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { createNodeEngineCatalogRuntime, createNodeRepositoryInspector, loadEngineCatalog, previewRun, requestRunStop, resolveEngineCatalogPath, resolveRunPermission, respondToRunInput, startRun, type IssueWithDetails, type ListIssueFilters, type ServiceContext } from "@issue-tracker/core";

import {
  commandFromMode,
  executeLinekeeperCommand,
  loadLinekeeperData,
  parseFilterInput,
  type LinekeeperCommand,
  type LinekeeperCoreCommand,
  type LinekeeperData,
  type LinekeeperLoadOptions
} from "./data.js";
import {
  childDoneMarker,
  formatActivityEvent,
  formatActor,
  formatTime,
  issueAssignee,
  issueCreator,
  issueCycle,
  issueProject,
  issueState,
  lastAgentActivity,
  padColumn,
  priorityLabel,
  shortActor
} from "./format.js";
import { mapKeyToLinekeeperAction } from "./keys.js";
import {
  initialLinekeeperState,
  linekeeperSections,
  reduceLinekeeperState,
  selectedSection,
  type LinekeeperUiState
} from "./state.js";

export interface LinekeeperAppProps {
  context: ServiceContext;
  dbPath: string;
  defaultTeam?: string;
}

export function LinekeeperApp({ context, dbPath, defaultTeam }: LinekeeperAppProps) {
  const { exit } = useApp();
  const [loadOptions, setLoadOptions] = useState<LinekeeperLoadOptions>({
    team: defaultTeam
  });
  const [data, setData] = useState<LinekeeperData>(() =>
    loadLinekeeperData(context, loadOptions)
  );
  const [uiState, dispatchBase] = useReducer(
    (state: LinekeeperUiState, action: Parameters<typeof reduceLinekeeperState>[1]) =>
      reduceLinekeeperState(state, action, data.issues.length),
    undefined,
    initialLinekeeperState
  );
  const selectedIssue = useMemo(
    () => data.issues[Math.min(uiState.selectedIndex, Math.max(0, data.issues.length - 1))] ?? null,
    [data.issues, uiState.selectedIndex]
  );

  const { stdout } = useStdout();
  const [, bumpResize] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => bumpResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off?.("resize", onResize);
    };
  }, [stdout]);

  const [showHelp, setShowHelp] = useState(false);
  const [showFleet, setShowFleet] = useState(false);
  const [launchPreview, setLaunchPreview] = useState<ReturnType<typeof previewRun> | null>(null);

  const rows = typeof stdout?.rows === "number" && stdout.rows > 0 ? stdout.rows : 24;
  const columns = typeof stdout?.columns === "number" && stdout.columns > 0 ? stdout.columns : 80;
  const activityLines = uiState.activityExpanded ? Math.max(1, Math.min(6, data.activity.length)) + 1 : 1;
  // Chrome = header (2) + body border (2) + activity + command line (1).
  const bodyCapacity = Math.max(3, rows - (2 + 2 + activityLines + 1));

  function reload(nextOptions: LinekeeperLoadOptions = loadOptions): LinekeeperData {
    const nextData = loadLinekeeperData(context, nextOptions);
    setData(nextData);
    dispatchBase({ type: "clampSelection" });
    return nextData;
  }

  useInput((input, key) => {
    if (launchPreview) {
      if (key.escape) { setLaunchPreview(null); return; }
      if (key.return) {
        try {
          startRun(context, { issue: launchPreview.issue.identifier, profile: launchPreview.profile.name, previewFingerprint: launchPreview.previewFingerprint, confirmWarnings: launchPreview.warnings }, runRuntime());
          setLaunchPreview(null);
          reload();
          dispatchBase({ type: "setStatus", message: `Started run for ${launchPreview.issue.identifier}.` });
        } catch (error) { dispatchBase({ type: "setStatus", message: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      return;
    }
    const action = mapKeyToLinekeeperAction(input, key, uiState);

    if (action.type === "none") return;
    if (action.type === "quit") {
      exit();
      return;
    }
    if (action.type === "copyIdentifier") {
      const copied = copyIdentifierToClipboard(selectedIssue?.identifier ?? "");
      dispatchBase({
        type: "setStatus",
        message: selectedIssue
          ? copied
            ? `Copied ${selectedIssue.identifier}.`
            : "Clipboard unavailable."
          : "No issue selected."
      });
      return;
    }
    if (action.type === "openSelected") {
      dispatchBase({ type: "focusNext" });
      return;
    }
    if (action.type === "toggleHelp") {
      setShowHelp((value) => !value);
      return;
    }
    if (action.type === "toggleFleet") { setShowFleet((value) => !value); return; }
    if (action.type === "previewRun") {
      if (!selectedIssue) { dispatchBase({ type: "setStatus", message: "No issue selected." }); return; }
      try { setLaunchPreview(previewRun(context, { issue: selectedIssue.identifier }, runRuntime())); }
      catch (error) { dispatchBase({ type: "setStatus", message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (action.type === "stopRun") {
      const active = data.runs.find((run) => run.issueId === selectedIssue?.id && !run.completedAt);
      if (!active) { dispatchBase({ type: "setStatus", message: "Selected issue has no active run." }); return; }
      try { requestRunStop(context, active.id); reload(); dispatchBase({ type: "setStatus", message: `Stop requested for ${active.id}.` }); }
      catch (error) { dispatchBase({ type: "setStatus", message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (action.type === "pageSelection") {
      const delta = action.delta * bodyCapacity;
      dispatchBase(
        uiState.focus === "detail"
          ? { type: "scrollDetail", delta }
          : { type: "moveSelection", delta }
      );
      return;
    }
    if (action.type === "submitMode") {
      submitMode(selectedIssue);
      return;
    }

    dispatchBase(action);
  });

  function submitMode(issue: IssueWithDetails | null): void {
    const mode = uiState.mode;
    if (!mode) return;

    try {
      if (mode.kind === "runResponse") {
        const run = data.runs.find((candidate) => candidate.issueId === issue?.id && !candidate.completedAt);
        const request = run?.inputRequests.find((candidate) => candidate.state === "pending");
        if (!run || !request) throw new Error("Selected issue has no pending run request.");
        if (request.kind === "permission") {
          const decision = mode.input.trim().toLowerCase();
          if (!["approve", "approved", "deny", "denied"].includes(decision)) throw new Error("Enter approve or deny for a permission request.");
          resolveRunPermission(context, { run: run.id, request: request.id, decision: decision.startsWith("approv") ? "approved" : "denied" });
        } else {
          respondToRunInput(context, { run: run.id, request: request.id, response: mode.input.trim() });
        }
        reload(loadOptions);
        dispatchBase({ type: "setStatus", message: `Resolved request ${request.id}.` });
        return;
      }
      const command = commandFromMode(mode, issue, defaultTeam);

      if (command.kind === "search") {
        const nextOptions = { ...loadOptions, search: command.input || null, view: null };
        reloadAndCommit(nextOptions);
        dispatchBase({
          type: "setStatus",
          message: command.input ? `Searching "${command.input}".` : "Search cleared."
        });
      } else if (command.kind === "view") {
        const nextOptions = { ...loadOptions, view: command.input || null, search: null };
        reloadAndCommit(nextOptions);
        dispatchBase({
          type: "setStatus",
          message: command.input ? `Loaded view ${command.input}.` : "View cleared."
        });
      } else if (command.kind === "filter") {
        const filters = command.input ? parseFilterInput(command.input) : {};
        const nextOptions = {
          ...loadOptions,
          filters: mergeFilters(loadOptions.filters, filters),
          search: null
        };
        reloadAndCommit(nextOptions);
        dispatchBase({
          type: "setStatus",
          message: command.input ? `Applied filters ${command.input}.` : "Filters cleared."
        });
      } else if (isCoreCommand(command)) {
        const result = executeLinekeeperCommand(context, command);
        reload(loadOptions);
        dispatchBase({ type: "setStatus", message: result.message });
      }
    } catch (error) {
      dispatchBase({
        type: "setStatus",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      dispatchBase({ type: "submitMode" });
    }
  }

  function reloadAndCommit(nextOptions: LinekeeperLoadOptions): LinekeeperData {
    const nextData = reload(nextOptions);
    setLoadOptions(nextOptions);
    return nextData;
  }

  return (
    <Box flexDirection="column">
      <Header data={data} />
      {launchPreview ? (
        <RunPreview preview={launchPreview} capacity={bodyCapacity} columns={columns} />
      ) : showHelp ? (
        <HelpOverlay dbPath={dbPath} capacity={bodyCapacity} columns={columns} />
      ) : showFleet ? (
        <FleetView data={data} capacity={bodyCapacity} columns={columns} />
      ) : uiState.focus === "detail" ? (
        <IssueDetail
          data={data}
          issue={selectedIssue}
          uiState={uiState}
          capacity={bodyCapacity}
          columns={columns}
        />
      ) : (
        <IssueList
          data={data}
          selectedIssue={selectedIssue}
          uiState={uiState}
          capacity={bodyCapacity}
          columns={columns}
        />
      )}
      <ActivityStrip data={data} expanded={uiState.activityExpanded} columns={columns} />
      <CommandLine uiState={uiState} />
    </Box>
  );
}

function isCoreCommand(command: LinekeeperCommand): command is LinekeeperCoreCommand {
  return command.kind !== "search" && command.kind !== "filter" && command.kind !== "view" && command.kind !== "runResponse";
}

function runRuntime() {
  const engineRuntime = createNodeEngineCatalogRuntime();
  return { inspector: createNodeRepositoryInspector(), dataRoot: resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "issue-tracker"), engineCatalog: loadEngineCatalog(resolveEngineCatalogPath(), engineRuntime), executableAvailable: engineRuntime.executableAvailable };
}

function Header({ data }: { data: LinekeeperData }) {
  const teamLabel = data.activeTeamKey ?? data.teams[0]?.key ?? "all teams";
  const viewLabel = data.activeView ?? "My Open";
  const count = data.issues.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold>Linekeeper</Text>
        <Text color="gray"> | {teamLabel} | {viewLabel} | {count} issues</Text>
      </Text>
      <Text color="gray" wrap="truncate">
        up/down move | enter open | r run | x stop | F fleet | supervisor {data.supervisor.healthy ? "online" : "offline: start tracker-agentd"} | ? help | q quit
      </Text>
    </Box>
  );
}

function HelpOverlay({
  dbPath,
  capacity,
  columns
}: {
  dbPath: string;
  capacity: number;
  columns: number;
}) {
  const lines: string[] = [
    "Navigation",
    "  up/down or j/k   move selection      PgUp/PgDn   jump a page",
    "  gg / G           top / bottom        enter       open issue detail",
    "  esc / left       back to list        [ / ]       prev / next section",
    "  A            toggle activity     y           copy identifier",
    "",
    "Commands",
    "  / search   f filter   v views   n new   m move   p priority",
    "  a assign   l labels   c comment  s sub-issue   b link",
    "  r preview run   x stop run   e answer/approve   F fleet",
    "",
    `db ${dbPath}`,
    "",
    "? close help"
  ];

  return (
    <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1} width={columns}>
      <Text bold>Help</Text>
      {lines.slice(0, Math.max(1, capacity - 1)).map((line, index) => (
        <Text key={index} color={line.trim() && !line.startsWith(" ") ? "cyan" : "gray"} wrap="truncate">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

function RunPreview({ preview, capacity, columns }: { preview: ReturnType<typeof previewRun>; capacity: number; columns: number }) {
  const lines = [
    `${preview.issue.identifier} ${preview.issue.title}`,
    `profile ${preview.profile.name} | workflow ${preview.workflow}@${preview.workflowVersion}`,
    ...preview.repositories.flatMap((repository) => [
      `repo ${repository.name} ${repository.baseRef}@${repository.baseCommit.slice(0, 12)}`,
      `worktree ${repository.worktreePath}`,
      `branch ${repository.branch}`,
      `verify ${repository.commands.verification.executable} ${repository.commands.verification.args.join(" ")}`
    ]),
    `roles ${Object.entries(preview.profile.configuration.roles).map(([role, engine]) => `${role}=${engine}`).join(", ")}`,
    `permission ${preview.policies.permission} | push ${preview.policies.push} | draft PR ${preview.policies.draftPr} | merge human-only`,
    ...(preview.warnings.length ? [`warnings ${preview.warnings.join(", ")}`] : []),
    "",
    "Enter confirms and starts | Esc cancels"
  ];
  return <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1} width={columns}>
    <Text bold color="yellow">Autonomous run preview</Text>
    {lines.slice(0, Math.max(1, capacity - 1)).map((line, index) => <Text key={index} wrap="truncate" color={line.startsWith("warnings") ? "yellow" : undefined}>{line || " "}</Text>)}
  </Box>;
}

function FleetView({ data, capacity, columns }: { data: LinekeeperData; capacity: number; columns: number }) {
  const priority: Record<string, number> = { waiting_for_input: 0, blocked: 1, stalled: 2, failed: 3, crashed: 4, running: 5, provisioning: 6, queued: 7, partial: 8, canceled: 9, succeeded: 10 };
  const rows = [...data.runs].sort((left, right) => (priority[left.state] ?? 99) - (priority[right.state] ?? 99) || left.lastProgressAt.localeCompare(right.lastProgressAt) || left.id.localeCompare(right.id));
  return <Box borderStyle="single" borderColor="magenta" flexDirection="column" paddingX={1} width={columns}>
    <Text bold color="magenta">Fleet</Text>
    {rows.length === 0 ? <Text color="gray">No coding runs.</Text> : rows.slice(0, Math.max(1, capacity - 1)).map((run) => {
      const issue = data.issues.find((candidate) => candidate.id === run.issueId);
      const participant = run.participants.find((candidate) => candidate.state === "running");
      return <Text key={run.id} color={["waiting_for_input", "blocked", "stalled", "failed", "crashed"].includes(run.state) ? "yellow" : run.completedAt ? "gray" : "magenta"} wrap="truncate">
        {issue?.identifier ?? run.issueId} | {run.phase}/{run.state} | {participant ? `${participant.role}:${participant.actualModel ?? participant.requestedModel}` : "idle"} | {run.branch}
      </Text>;
    })}
  </Box>;
}

function IssueList({
  data,
  selectedIssue,
  uiState,
  capacity,
  columns
}: {
  data: LinekeeperData;
  selectedIssue: IssueWithDetails | null;
  uiState: LinekeeperUiState;
  capacity: number;
  columns: number;
}) {
  const total = data.issues.length;
  const rowCapacity = Math.max(1, capacity - 1); // reserve one row for the footer
  const offsetRef = useRef(0);

  let offset = offsetRef.current;
  if (uiState.selectedIndex < offset) offset = uiState.selectedIndex;
  if (uiState.selectedIndex >= offset + rowCapacity) offset = uiState.selectedIndex - rowCapacity + 1;
  offset = Math.min(Math.max(0, offset), Math.max(0, total - rowCapacity));
  offsetRef.current = offset;

  const visible = data.issues.slice(offset, offset + rowCapacity);
  const above = offset;
  const below = Math.max(0, total - (offset + visible.length));

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      flexDirection="column"
      width={columns}
      paddingX={1}
    >
      {total === 0 ? (
        <Text color="gray">No issues match this view.</Text>
      ) : (
        visible.map((issue) => {
          const selected = issue.id === selectedIssue?.id;
          const state = issueState(data, issue);
          const assignee = issueAssignee(data, issue);
          const agentActive = lastAgentActivity(data, issue) !== null;
          const color = selected ? "cyan" : agentActive ? "magenta" : undefined;
          const row =
            `${selected ? ">" : " "} ${agentActive ? "*" : " "} ` +
            `${padColumn(issue.identifier, 7)} ${padColumn(state?.name ?? "Unknown", 12)} ` +
            `${padColumn(priorityLabel(issue.priority), 11)} ${padColumn(shortActor(assignee), 14)} ` +
            issue.title;

          return (
            <Text key={issue.id} color={color} wrap="truncate">
              {row}
            </Text>
          );
        })
      )}
      <Text color="gray" wrap="truncate">
        {total === 0
          ? "0 issues"
          : `${above > 0 ? `^ ${above}  ` : ""}${uiState.selectedIndex + 1}/${total}${
              below > 0 ? `  v ${below}` : ""
            }`}
      </Text>
    </Box>
  );
}

interface DetailLine {
  text: string;
  color?: string;
  bold?: boolean;
}

function IssueDetail({
  data,
  issue,
  uiState,
  capacity,
  columns
}: {
  data: LinekeeperData;
  issue: IssueWithDetails | null;
  uiState: LinekeeperUiState;
  capacity: number;
  columns: number;
}) {
  if (!issue) {
    return (
      <Box borderStyle="single" borderColor="cyan" flexDirection="column" width={columns} paddingX={1}>
        <Text color="gray">Select an issue to see details.</Text>
      </Box>
    );
  }

  const state = issueState(data, issue);
  const project = issueProject(data, issue);
  const cycle = issueCycle(data, issue);
  const assignee = issueAssignee(data, issue);
  const creator = issueCreator(data, issue);
  const section = selectedSection(uiState);
  const contentWidth = Math.max(10, columns - 4);
  const metaColor = section === "metadata" ? "cyan" : undefined;

  const lines: DetailLine[] = [
    { text: `${issue.identifier}  ${issue.title}`, bold: true },
    {
      text:
        `${state?.name ?? "Unknown"} - ${priorityLabel(issue.priority)}` +
        (issue.labels.length ? ` - ${issue.labels.map((label) => label.name).join(", ")}` : ""),
      color: "gray"
    },
    { text: `Project: ${project?.name ?? "none"}`, color: metaColor },
    {
      text: `Cycle: ${cycle ? cycle.name ?? `Cycle ${cycle.number}` : "none"} - Estimate: ${
        issue.estimate ?? "none"
      }`,
      color: metaColor
    },
    {
      text: `Assignee: ${formatActor(assignee)}`,
      color: assignee?.type === "agent" ? "magenta" : metaColor
    },
    { text: `Creator: ${creator?.name ?? "unknown"}`, color: metaColor },
    { text: `Parent: ${issue.parent?.identifier ?? "none"}`, color: metaColor }
  ];

  const issueRuns = data.runs.filter((run) => run.issueId === issue.id);
  if (issueRuns.length === 0) lines.push({ text: "Runs: none", color: section === "runs" ? "cyan" : "gray" });
  for (const run of issueRuns) {
    const participant = run.participants.find((candidate) => candidate.state === "running") ?? run.participants[0];
    lines.push({ text: `Run: ${run.phase}/${run.state} ${participant ? `${participant.role}:${participant.actualModel ?? participant.requestedModel}` : ""}`.trimEnd(), color: run.state === "waiting_for_input" || run.state === "stalled" || run.state === "blocked" ? "yellow" : run.completedAt ? "gray" : section === "runs" ? "cyan" : "magenta" });
    for (const request of run.inputRequests.filter((candidate) => candidate.state === "pending")) lines.push({ text: `  ${request.kind}: ${request.prompt} (e to respond)`, color: "yellow" });
  }
  lines.push(
    { text: "" },
    { text: "Sub-issues:", color: section === "subIssues" ? "cyan" : undefined }
  );

  if (issue.children.length === 0) {
    lines.push({ text: "  none", color: "gray" });
  } else {
    for (const child of issue.children) {
      lines.push({ text: `  ${childDoneMarker(data, child.id)} ${child.identifier} ${child.title}` });
    }
  }

  if (issue.blockedBy.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Blocked by:", color: metaColor });
    for (const blocker of issue.blockedBy) {
      lines.push({ text: `  ${blocker.identifier} ${blocker.title}` });
    }
  }

  if (issue.blocks.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Blocks:", color: metaColor });
    for (const blocked of issue.blocks) {
      lines.push({ text: `  ${blocked.identifier} ${blocked.title}` });
    }
  }

  lines.push({ text: "" });
  lines.push({ text: "Description", color: section === "description" ? "cyan" : undefined });
  for (const line of wrapText(issue.description ?? "none", contentWidth)) {
    lines.push({ text: line });
  }

  lines.push({ text: "" });
  lines.push({ text: "Comments", color: section === "comments" ? "cyan" : undefined });
  if (issue.comments.length === 0) {
    lines.push({ text: "  none", color: "gray" });
  } else {
    for (const comment of issue.comments.slice(-4)) {
      for (const line of wrapText(
        `${formatTime(comment.createdAt)} ${comment.author.handle}: ${comment.body}`,
        contentWidth
      )) {
        lines.push({ text: line });
      }
    }
  }

  const viewport = Math.max(1, capacity - 1); // reserve one row for the footer
  const maxOffset = Math.max(0, lines.length - viewport);
  const scroll = Math.min(uiState.detailScroll, maxOffset);
  const visible = lines.slice(scroll, scroll + viewport);
  const below = Math.max(0, lines.length - (scroll + visible.length));

  return (
    <Box borderStyle="single" borderColor="cyan" flexDirection="column" width={columns} paddingX={1}>
      {visible.map((line, index) => (
        <Text key={scroll + index} color={line.color} bold={line.bold} wrap="truncate">
          {line.text || " "}
        </Text>
      ))}
      <Text color="gray" wrap="truncate">
        {`Section ${linekeeperSections.indexOf(section) + 1}/${linekeeperSections.length} | [ ] section | up/down scroll | esc back`}
        {scroll > 0 ? `  ^ ${scroll}` : ""}
        {below > 0 ? `  v ${below}` : ""}
      </Text>
    </Box>
  );
}

function wrapText(value: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of value.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    out.push(remaining);
  }
  return out;
}

function ActivityStrip({
  data,
  expanded,
  columns
}: {
  data: LinekeeperData;
  expanded: boolean;
  columns: number;
}) {
  if (!expanded) {
    const latest = data.activity.at(-1);
    return (
      <Box paddingX={1} width={columns}>
        <Text color="gray" wrap="truncate">
          ACTIVITY{"  "}
          {latest ? (
            <Text color={latest.actor.type === "agent" ? "magenta" : "gray"}>
              {formatActivityEvent(latest)}
            </Text>
          ) : (
            "No activity yet."
          )}
          {"  "}(A to expand)
        </Text>
      </Box>
    );
  }

  const events = data.activity.slice(-6);
  return (
    <Box flexDirection="column" paddingX={1} width={columns}>
      <Text bold>ACTIVITY (expanded - A to collapse)</Text>
      {events.length === 0 ? (
        <Text color="gray">No activity yet.</Text>
      ) : (
        events.map((event) => (
          <Text key={event.id} color={event.actor.type === "agent" ? "magenta" : undefined} wrap="truncate">
            {formatActivityEvent(event)}
          </Text>
        ))
      )}
    </Box>
  );
}

function CommandLine({ uiState }: { uiState: LinekeeperUiState }) {
  if (uiState.mode) {
    return (
      <Text color="cyan">
        {modePrompt(uiState.mode.kind)}
        {uiState.mode.input}
      </Text>
    );
  }

  return <Text color="gray">{uiState.statusMessage ?? "Ready."}</Text>;
}

function modePrompt(kind: NonNullable<LinekeeperUiState["mode"]>["kind"]): string {
  switch (kind) {
    case "search":
      return "/ ";
    case "filter":
      return "filter state=Todo assignee=@codex ";
    case "view":
      return "view ";
    case "new":
      return "new title ";
    case "move":
      return "move state ";
    case "priority":
      return "priority ";
    case "assign":
      return "assign ";
    case "labels":
      return "labels comma,separated ";
    case "comment":
      return "comment ";
    case "subIssue":
      return "sub-issue title ";
    case "link":
      return "link URL or branch <repo> <name> ";
    case "runResponse":
      return "run response/approve ";
  }
}

function mergeFilters(
  current: ListIssueFilters | undefined,
  next: ListIssueFilters
): ListIssueFilters {
  return Object.keys(next).length === 0 ? {} : { ...(current ?? {}), ...next };
}

export function copyIdentifierToClipboard(identifier: string): boolean {
  if (!identifier) return false;

  for (const candidate of clipboardCandidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      input: identifier,
      stdio: ["pipe", "ignore", "ignore"]
    });

    if (!result.error && result.status === 0) {
      return true;
    }
  }

  return false;
}

const clipboardCandidates = [
  { command: "pbcopy", args: [] },
  { command: "wl-copy", args: [] },
  { command: "xclip", args: ["-selection", "clipboard"] },
  { command: "clip", args: [] }
];
