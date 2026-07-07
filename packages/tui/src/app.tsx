import { spawnSync } from "node:child_process";

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useReducer, useState } from "react";

import type { IssueWithDetails, ListIssueFilters, ServiceContext } from "@issue-tracker/core";

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
  formatLastAgentActivity,
  formatTime,
  issueAssignee,
  issueCreator,
  issueCycle,
  issueProject,
  issueState,
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

  function reload(nextOptions: LinekeeperLoadOptions = loadOptions): LinekeeperData {
    const nextData = loadLinekeeperData(context, nextOptions);
    setData(nextData);
    dispatchBase({ type: "clampSelection" });
    return nextData;
  }

  useEffect(() => {
    reload(loadOptions);
  }, [loadOptions]);

  useInput((input, key) => {
    const action = mapKeyToLinekeeperAction(input, key, uiState);

    if (action.type === "none") return;
    if (action.type === "quit") {
      exit();
      return;
    }
    if (action.type === "copyIdentifier") {
      copyIdentifier(selectedIssue?.identifier ?? "");
      dispatchBase({
        type: "setStatus",
        message: selectedIssue ? `Copied ${selectedIssue.identifier}.` : "No issue selected."
      });
      return;
    }
    if (action.type === "openSelected") {
      dispatchBase({ type: "focusNext" });
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
      const command = commandFromMode(mode, issue, defaultTeam);

      if (command.kind === "search") {
        const nextOptions = { ...loadOptions, search: command.input || null, view: null };
        setLoadOptions(nextOptions);
        dispatchBase({
          type: "setStatus",
          message: command.input ? `Searching "${command.input}".` : "Search cleared."
        });
      } else if (command.kind === "view") {
        const nextOptions = { ...loadOptions, view: command.input || null, search: null };
        setLoadOptions(nextOptions);
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
        setLoadOptions(nextOptions);
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

  return (
    <Box flexDirection="column">
      <Header data={data} dbPath={dbPath} />
      <Box>
        <IssueList data={data} selectedIssue={selectedIssue} uiState={uiState} />
        <IssueDetail data={data} issue={selectedIssue} uiState={uiState} />
      </Box>
      <ActivityStrip data={data} expanded={uiState.activityExpanded} />
      <CommandLine uiState={uiState} />
    </Box>
  );
}

function isCoreCommand(command: LinekeeperCommand): command is LinekeeperCoreCommand {
  return command.kind !== "search" && command.kind !== "filter" && command.kind !== "view";
}

function Header({ data, dbPath }: { data: LinekeeperData; dbPath: string }) {
  const teamLabel = data.activeTeamKey ?? data.teams[0]?.key ?? "all teams";
  const viewLabel = data.activeView ?? "My Open";

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>
        Linekeeper - {teamLabel} issues - {viewLabel} - live agent feed
      </Text>
      <Text color="gray">
        q quit  / search  f filters  v views  n new  m move  p priority  a assign  c comment
      </Text>
      <Text color="gray">db {dbPath}</Text>
    </Box>
  );
}

function IssueList({
  data,
  selectedIssue,
  uiState
}: {
  data: LinekeeperData;
  selectedIssue: IssueWithDetails | null;
  uiState: LinekeeperUiState;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor={uiState.focus === "list" ? "cyan" : "gray"}
      flexDirection="column"
      width={42}
      paddingX={1}
    >
      <Text bold>
        VIEW: {data.activeView ?? "My Open"}      STATE
      </Text>
      {data.issues.length === 0 ? (
        <Text color="gray">No issues match this view.</Text>
      ) : (
        data.issues.slice(0, 12).map((issue) => {
          const selected = issue.id === selectedIssue?.id;
          const state = issueState(data, issue);
          const assignee = issueAssignee(data, issue);
          const agentLine = formatLastAgentActivity(data, issue);

          return (
            <Box key={issue.id} flexDirection="column" marginTop={1}>
              <Text color={selected ? "cyan" : undefined}>
                {selected ? "> " : "  "}
                {issue.identifier} {issue.title}
              </Text>
              <Text color="gray">
                {"  "}
                {state?.name ?? "Unknown"}  {priorityLabel(issue.priority)}
              </Text>
              <Text color={assignee?.type === "agent" ? "magenta" : "gray"}>
                {"  "}
                {shortActor(assignee)}  {formatTime(issue.updatedAt)}
              </Text>
              {agentLine ? (
                <Text color="magenta">
                  {"  "}
                  {agentLine}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}

function IssueDetail({
  data,
  issue,
  uiState
}: {
  data: LinekeeperData;
  issue: IssueWithDetails | null;
  uiState: LinekeeperUiState;
}) {
  if (!issue) {
    return (
      <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1}>
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

  return (
    <Box
      borderStyle="single"
      borderColor={uiState.focus === "detail" ? "cyan" : "gray"}
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
    >
      <Text bold>
        {issue.identifier}  {issue.title}
      </Text>
      <Text color="gray">
        {state?.name ?? "Unknown"} - {priorityLabel(issue.priority)}
        {issue.labels.length ? ` - ${issue.labels.map((label) => label.name).join(", ")}` : ""}
      </Text>
      <Text color={section === "metadata" ? "cyan" : undefined}>
        Project: {project?.name ?? "none"}
      </Text>
      <Text>
        Cycle: {cycle ? cycle.name ?? `Cycle ${cycle.number}` : "none"} - Estimate:{" "}
        {issue.estimate ?? "none"}
      </Text>
      <Text color={assignee?.type === "agent" ? "magenta" : undefined}>
        Assignee: {formatActor(assignee)}
      </Text>
      <Text>Creator: {creator?.name ?? "unknown"}</Text>
      <Text>Parent: {issue.parent?.identifier ?? "none"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={section === "subIssues" ? "cyan" : undefined}>Sub-issues:</Text>
        {issue.children.length === 0 ? (
          <Text color="gray">  none</Text>
        ) : (
          issue.children.map((child) => (
            <Text key={child.id}>
              {"  "}
              {childDoneMarker(data, child.id)} {child.identifier} {child.title}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={section === "description" ? "cyan" : undefined}>Description</Text>
        <Text>{issue.description ?? "none"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={section === "comments" ? "cyan" : undefined}>Comments</Text>
        {issue.comments.length === 0 ? (
          <Text color="gray">  none</Text>
        ) : (
          issue.comments.slice(-4).map((comment) => (
            <Text key={comment.id}>
              {formatTime(comment.createdAt)} {comment.author.handle}: {comment.body}
            </Text>
          ))
        )}
      </Box>
      <Text color="gray">
        Section {linekeeperSections.indexOf(section) + 1}/{linekeeperSections.length} - use [ and ]
      </Text>
    </Box>
  );
}

function ActivityStrip({ data, expanded }: { data: LinekeeperData; expanded: boolean }) {
  const events = data.activity.slice(expanded ? -8 : -3);

  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>ACTIVITY {expanded ? "(expanded)" : ""}</Text>
      {events.length === 0 ? (
        <Text color="gray">No activity yet.</Text>
      ) : (
        events.map((event) => (
          <Text key={event.id} color={event.actor.type === "agent" ? "magenta" : undefined}>
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
  }
}

function mergeFilters(
  current: ListIssueFilters | undefined,
  next: ListIssueFilters
): ListIssueFilters {
  return Object.keys(next).length === 0 ? {} : { ...(current ?? {}), ...next };
}

function copyIdentifier(identifier: string): void {
  if (!identifier) return;
  spawnSync("pbcopy", { input: identifier, stdio: ["pipe", "ignore", "ignore"] });
}
