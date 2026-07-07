#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigKey,
  addComment,
  addCommentInputSchema,
  addAttachment,
  archiveIssue,
  archiveIssueInputSchema,
  archiveLabel,
  archiveLabelInputSchema,
  archiveProject,
  archiveProjectInputSchema,
  archiveTeam,
  archiveTeamInputSchema,
  assignIssue,
  assignIssueInputSchema,
  backupDatabase,
  createActor,
  createActorInputSchema,
  createCycle,
  createCycleInputSchema,
  createLabel,
  createLabelInputSchema,
  createIssueInputSchema,
  createIssue,
  createIssueFromTemplate,
  createIssueFromTemplateOverridesSchema,
  createProjectInputSchema,
  createProject,
  createSavedView,
  createSavedViewInputSchema,
  createTeam,
  createTemplate,
  createTemplateInputSchema,
  deleteSavedView,
  deleteSavedViewInputSchema,
  deleteTemplate,
  deleteTemplateInputSchema,
  exportSnapshot,
  getConfig,
  getIssue,
  getProject,
  listActivity,
  listActivityInputSchema,
  listActivitySince,
  listActivitySinceInputSchema,
  listActors,
  listActorsInputSchema,
  linkIssueInputSchema,
  listCycles,
  listCyclesInputSchema,
  listLabels,
  listLabelsInputSchema,
  listIssueFiltersSchema,
  listIssuesWithView,
  listIssuesWithViewInputSchema,
  listProjectsInputSchema,
  listProjects,
  listSavedViews,
  listSavedViewsInputSchema,
  listTeamsInputSchema,
  listTeams,
  listTemplates,
  listTemplatesInputSchema,
  moveIssueInputSchema,
  projectStatusSchema,
  moveIssue,
  resolveBackupPath,
  searchInputSchema,
  searchIssues,
  setConfig,
  type ServiceContext,
  unarchiveIssue,
  unarchiveIssueInputSchema,
  unarchiveLabel,
  unarchiveLabelInputSchema,
  unarchiveProject,
  unarchiveProjectInputSchema,
  unarchiveTeam,
  unarchiveTeamInputSchema,
  updateIssueInputSchema,
  updateIssue,
  updateProjectInputSchema,
  updateProject,
  whoami,
  init as initWorkspace,
  type AddCommentInput,
  type AddAttachmentInput,
  type AssignIssueInput,
  type CreateActorInput,
  type CreateIssueFromTemplateOverrides,
  type CreateIssueInput,
  type CreateCycleInput,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateSavedViewInput,
  type CreateTemplateInput,
  type ListActivitySinceInput,
  type ListIssuesWithViewInput,
  type ListIssueFilters,
  type SearchIssuesInput,
  type UpdateIssueInput,
  type UpdateProjectInput
} from "@issue-tracker/core";
import { runStdioServer } from "@issue-tracker/mcp";
import { Command, InvalidArgumentError } from "commander";

import { openCliContext, resolveDbPath, type CliGlobalOptions } from "./context.js";
import {
  handleCliError,
  printActor,
  printActors,
  printActivity,
  printActivityEvents,
  printAttachment,
  printComment,
  printCycle,
  printCycles,
  printIssue,
  printIssues,
  printJson,
  printLabel,
  printLabels,
  printProject,
  printProjects,
  printSavedView,
  printSavedViews,
  printTeam,
  printTeams,
  printTemplate,
  printTemplates,
  printValue,
  type OutputOptions
} from "./output.js";

type CommandOptions = CliGlobalOptions &
  OutputOptions & {
    [key: string]: unknown;
    actorHandle?: string;
    actorName?: string;
    agent?: string;
    includeArchived?: boolean;
    output?: string;
    teamKey?: string;
    teamName?: string;
    workspace?: string;
  };

export function createProgram(): Command {
  const program = new Command()
    .name("tracker")
    .description("Local-first issue tracker CLI")
    .version("0.0.0")
    .option("--db <path>", "SQLite database path")
    .option("--json", "print JSON output")
    .option("--team <key>", "default team key")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeErr: () => {}
    });

  program
    .command("init")
    .description("create the database and seed default records")
    .option("--workspace <name>", "workspace name")
    .option("--team-key <key>", "initial team key")
    .option("--team-name <name>", "initial team name")
    .option("--actor-name <name>", "default actor name")
    .option("--actor-handle <handle>", "default actor handle")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const globalOptions = optionsWithGlobals(command);
        const result = initWorkspace(cli.context, {
          workspaceName: globalOptions.workspace,
          teamKey: globalOptions.teamKey ?? globalOptions.team,
          teamName: globalOptions.teamName,
          actorName: globalOptions.actorName,
          actorHandle: globalOptions.actorHandle
        });

        if (globalOptions.json) {
          printJson({
            workspace: result.workspace,
            team: result.team,
            actor: result.actor
          });
          return;
        }

        process.stdout.write(`Initialized ${cli.dbPath}\n`);
      })
    );

  program
    .command("whoami")
    .description("show the current default actor")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, {}, (cli) => {
        printActor(whoami(cli.context), optionsWithGlobals(command));
      })
    );

  const config = program.command("config").description("read and write local settings");
  config
    .command("get")
    .argument("<key>")
    .option("--json", "print JSON output")
    .action((key, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const value = getConfig(cli.context, normalizeConfigKey(key));

        if (optionsWithGlobals(command).json) {
          printJson({ key: normalizeConfigKey(key), value });
          return;
        }

        printValue(value);
      })
    );
  config
    .command("set")
    .argument("<key>")
    .argument("<value>")
    .option("--json", "print JSON output")
    .action((key, value, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const normalizedKey = normalizeConfigKey(key);
        setConfig(cli.context, normalizedKey, value);

        if (optionsWithGlobals(command).json) {
          printJson({ key: normalizedKey, value });
          return;
        }

        printValue(value);
      })
    );

  const actor = program.command("actor").description("manage actors");
  actor
    .command("create")
    .argument("<handle>")
    .argument("<name>")
    .requiredOption("--type <type>", "actor type: human or agent")
    .option("--json", "print JSON output")
    .action((handle, name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printActor(createActor(cli.context, actorCreateInput(handle, name, options)), options);
      })
    );
  actor
    .command("list")
    .option("--include-archived", "include archived actors")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printActors(
          listActors(
            cli.context,
            listActorsInputSchema.parse({ includeArchived: options.includeArchived })
          ),
          options
        );
      })
    );

  const team = program.command("team").description("manage teams");
  team
    .command("create")
    .argument("<key>")
    .argument("<name>")
    .option("--json", "print JSON output")
    .action((key, name, _options, command) =>
      withContext(command, {}, (cli) => {
        printTeam(createTeam(cli.context, { key, name }), optionsWithGlobals(command));
      })
    );
  team
    .command("list")
    .option("--include-archived", "include archived teams")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printTeams(
          listTeams(
            cli.context,
            listTeamsInputSchema.parse({ includeArchived: options.includeArchived })
          ),
          options
        );
      })
    );
  team
    .command("archive")
    .argument("<team>")
    .option("--json", "print JSON output")
    .action((teamRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = archiveTeamInputSchema.parse({ team: teamRef });
        printTeam(archiveTeam(cli.context, input.team), optionsWithGlobals(command));
      })
    );
  team
    .command("unarchive")
    .argument("<team>")
    .option("--json", "print JSON output")
    .action((teamRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = unarchiveTeamInputSchema.parse({ team: teamRef });
        printTeam(unarchiveTeam(cli.context, input.team), optionsWithGlobals(command));
      })
    );

  const label = program.command("label").description("manage labels");
  label
    .command("create")
    .argument("<name>")
    .option("--color <color>", "label color")
    .option("--group <group>", "label group")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printLabel(createLabel(cli.context, labelCreateInput(name, options)), options);
      })
    );
  label
    .command("list")
    .option("--include-archived", "include archived labels")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printLabels(
          listLabels(
            cli.context,
            listLabelsInputSchema.parse({ includeArchived: options.includeArchived })
          ),
          options
        );
      })
    );
  label
    .command("archive")
    .argument("<label>")
    .option("--json", "print JSON output")
    .action((labelRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = archiveLabelInputSchema.parse({ label: labelRef });
        printLabel(archiveLabel(cli.context, input.label), optionsWithGlobals(command));
      })
    );
  label
    .command("unarchive")
    .argument("<label>")
    .option("--json", "print JSON output")
    .action((labelRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = unarchiveLabelInputSchema.parse({ label: labelRef });
        printLabel(unarchiveLabel(cli.context, input.label), optionsWithGlobals(command));
      })
    );

  const cycle = program.command("cycle").description("manage cycles");
  cycle
    .command("create")
    .argument("[name]")
    .option("--name <name>", "cycle name")
    .option("--number <number>", "cycle number", parseInteger)
    .option("--team <key>", "team key or id")
    .option("--starts-at <timestamp>", "cycle start timestamp")
    .option("--ends-at <timestamp>", "cycle end timestamp")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printCycle(createCycle(cli.context, cycleCreateInput(name, options, cli.defaultTeam)), options);
      })
    );
  cycle
    .command("list")
    .option("--team <key>", "team key or id")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printCycles(
          listCycles(cli.context, cycleListInput(options, cli.defaultTeam)),
          options
        );
      })
    );

  const project = program.command("project").description("manage projects");
  project
    .command("create")
    .argument("[name]")
    .option("--name <name>", "project name")
    .option("--desc <description>", "project description")
    .option("--description <description>", "project description")
    .option("--status <status>", "project status")
    .option("--lead-id <actorId>", "lead actor id")
    .option("--start-date <date>", "start date")
    .option("--target-date <date>", "target date")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        printProject(createProject(cli.context, projectCreateInput(name, options)), options);
      })
    );
  project
    .command("list")
    .option("--include-archived", "include archived projects")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printProjects(
          listProjects(
            cli.context,
            listProjectsInputSchema.parse({ includeArchived: options.includeArchived })
          ),
          options
        );
      })
    );
  project
    .command("view")
    .argument("<project>")
    .option("--json", "print JSON output")
    .action((idOrName, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        printProject(getProject(cli.context, idOrName), optionsWithGlobals(command));
      })
    );
  project
    .command("update")
    .argument("<project>")
    .option("--name <name>", "project name")
    .option("--desc <description>", "project description")
    .option("--description <description>", "project description")
    .option("--status <status>", "project status")
    .option("--lead-id <actorId>", "lead actor id")
    .option("--start-date <date>", "start date")
    .option("--target-date <date>", "target date")
    .option("--json", "print JSON output")
    .action((idOrName, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        printProject(
          updateProject(cli.context, idOrName, projectUpdateInput(options)),
          options
        );
      })
    );
  project
    .command("archive")
    .argument("<project>")
    .option("--json", "print JSON output")
    .action((projectRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = archiveProjectInputSchema.parse({ project: projectRef });
        printProject(archiveProject(cli.context, input.project), optionsWithGlobals(command));
      })
    );
  project
    .command("unarchive")
    .argument("<project>")
    .option("--json", "print JSON output")
    .action((projectRef, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = unarchiveProjectInputSchema.parse({ project: projectRef });
        printProject(unarchiveProject(cli.context, input.project), optionsWithGlobals(command));
      })
    );

  const issue = program.command("issue").description("manage issues");
  issue
    .command("create")
    .argument("[title]")
    .option("--title <title>", "issue title")
    .option("--desc <description>", "issue description")
    .option("--description <description>", "issue description")
    .option("--team <key>", "team key")
    .option("--project <project>", "project id or name")
    .option("--cycle <cycle>", "cycle number or id")
    .option("--parent <issue>", "parent issue identifier or id")
    .option("--priority <number>", "priority", parseInteger)
    .option("--assignee <actor>", "assignee id or handle")
    .option("--state <state>", "workflow state")
    .option("--label <label>", "label name or id", collectValues, [])
    .option("--template <name>", "template name")
    .option("--json", "print JSON output")
    .action((title, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        const template = stringOption(options.template);
        const issue = template
          ? createIssueFromTemplate(
              cli.context,
              template,
              issueCreateTemplateOverrides(title, options)
            )
          : createIssue(cli.context, issueCreateInput(title, options, cli.defaultTeam));
        printIssue(cli.context, issue, options);
      })
    );
  issue
    .command("list")
    .option("--view <name>", "saved view name")
    .option("--state <state>", "workflow state")
    .option("--assignee <actor>", "assignee id or handle")
    .option("--unassigned", "only unassigned issues")
    .option("--project <project>", "project id or name")
    .option("--no-project", "only issues without a project")
    .option("--cycle <cycle>", "cycle number or id")
    .option("--label <label>", "label name")
    .option("--priority <number>", "priority", parseInteger)
    .option("--team <key>", "team key")
    .option("--limit <number>", "maximum number of issues", parseInteger)
    .option("--include-archived", "include archived issues")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printIssues(
          cli.context,
          listIssuesWithView(cli.context, issueListInput(options, cli.defaultTeam)),
          options
        );
      })
    );
  issue
    .command("search")
    .argument("<query>")
    .option("--team <key>", "team key")
    .option("--limit <number>", "maximum number of issues", parseInteger)
    .option("--json", "print JSON output")
    .action((query, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printIssues(
          cli.context,
          searchIssues(cli.context, issueSearchInput(query, options, cli.defaultTeam)),
          options
        );
      })
    );
  issue
    .command("view")
    .argument("<identifier>")
    .option("--json", "print JSON output")
    .action((identifier, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        printIssue(cli.context, getIssue(cli.context, identifier), optionsWithGlobals(command));
      })
    );
  issue
    .command("history")
    .argument("<identifier>")
    .option("--json", "print JSON output")
    .action((identifier, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = listActivityInputSchema.parse({ issue: identifier });
        printActivity(listActivity(cli.context, input), optionsWithGlobals(command));
      })
    );
  issue
    .command("update")
    .argument("<identifier>")
    .option("--title <title>", "issue title")
    .option("--desc <description>", "issue description")
    .option("--description <description>", "issue description")
    .option("--priority <number>", "priority", parseInteger)
    .option("--assignee <actor>", "assignee id or handle")
    .option("--unassigned", "clear assignee")
    .option("--project <project>", "project id or name")
    .option("--no-project", "clear project")
    .option("--cycle <cycle>", "cycle number or id")
    .option("--parent <issue>", "parent issue identifier or id; use 'none' to clear")
    .option("--label <label>", "add label by name or id", collectValues, [])
    .option("--remove-label <label>", "remove label by name or id", collectValues, [])
    .option("--estimate <number>", "estimate", parseInteger)
    .option("--due-date <date>", "due date")
    .option("--json", "print JSON output")
    .action((identifier, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        printIssue(
          cli.context,
          updateIssue(cli.context, identifier, issueUpdateInput(options)),
          options
        );
      })
    );
  issue
    .command("move")
    .argument("<identifier>")
    .argument("<state>")
    .option("--json", "print JSON output")
    .action((identifier, state, _options, command) =>
      withContext(command, {}, (cli) => {
        const input = moveIssueInputSchema.parse({ identifier, state });
        printIssue(
          cli.context,
          moveIssue(cli.context, input.identifier, input.state),
          optionsWithGlobals(command)
        );
      })
    );
  issue
    .command("assign")
    .argument("<identifier>")
    .argument("[actor]")
    .option("--me", "assign to the default actor")
    .option("--none", "clear assignee")
    .option("--json", "print JSON output")
    .action((identifier, actor, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        const input = issueAssignInput(identifier, actor, options, cli.context.actor?.id);
        printIssue(
          cli.context,
          assignIssue(cli.context, input.identifier, input.actor),
          options
        );
      })
    );
  issue
    .command("comment")
    .argument("<identifier>")
    .argument("<body>")
    .option("--parent <comment>", "parent comment id")
    .option("--json", "print JSON output")
    .action((identifier, body, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        printComment(
          addComment(cli.context, issueCommentInput(identifier, body, options)),
          options
        );
      })
    );
  issue
    .command("link")
    .argument("<identifier>")
    .argument("[url]")
    .option("--kind <kind>", "attachment kind: link, branch, pr, or commit", "link")
    .option("--url <url>", "attachment URL")
    .option("--repo <path>", "local repository path")
    .option("--remote <remote>", "git remote name")
    .option("--branch <name>", "branch name")
    .option("--sha <sha>", "commit SHA")
    .option("--title <title>", "attachment title")
    .option("--json", "print JSON output")
    .action((identifier, url, _options, command) =>
      withContext(command, {}, (cli) => {
        const options = optionsWithGlobals(command);
        printAttachment(
          addAttachment(cli.context, issueLinkInput(identifier, url, options)),
          options
        );
      })
    );
  issue
    .command("archive")
    .argument("<identifier>")
    .option("--json", "print JSON output")
    .action((identifier, _options, command) =>
      withContext(command, {}, (cli) => {
        const input = archiveIssueInputSchema.parse({ identifier });
        printIssue(
          cli.context,
          archiveIssue(cli.context, input.identifier),
          optionsWithGlobals(command)
        );
      })
    );
  issue
    .command("unarchive")
    .argument("<identifier>")
    .option("--json", "print JSON output")
    .action((identifier, _options, command) =>
      withContext(command, {}, (cli) => {
        const input = unarchiveIssueInputSchema.parse({ identifier });
        printIssue(
          cli.context,
          unarchiveIssue(cli.context, input.identifier),
          optionsWithGlobals(command)
        );
      })
    );

  const view = program.command("view").description("manage saved issue views");
  view
    .command("save")
    .argument("<name>")
    .option("--state <state>", "workflow state")
    .option("--assignee <actor>", "assignee id or handle")
    .option("--unassigned", "only unassigned issues")
    .option("--project <project>", "project id or name")
    .option("--no-project", "only issues without a project")
    .option("--cycle <cycle>", "cycle number or id")
    .option("--label <label>", "label name")
    .option("--priority <number>", "priority", parseInteger)
    .option("--team <key>", "team key")
    .option("--include-archived", "include archived issues")
    .option("--desc <description>", "view description")
    .option("--description <description>", "view description")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printSavedView(
          createSavedView(cli.context, savedViewCreateInput(name, options, cli.defaultTeam)),
          options
        );
      })
    );
  view
    .command("list")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        listSavedViewsInputSchema.parse({});
        printSavedViews(listSavedViews(cli.context), optionsWithGlobals(command));
      })
    );
  view
    .command("delete")
    .argument("<name>")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = deleteSavedViewInputSchema.parse({ idOrName: name });
        printSavedView(deleteSavedView(cli.context, input.idOrName), optionsWithGlobals(command));
      })
    );

  const template = program.command("template").description("manage issue templates");
  template
    .command("create")
    .argument("<name>")
    .option("--title <title>", "issue title")
    .option("--desc <description>", "issue description")
    .option("--description <description>", "issue description")
    .option("--priority <number>", "priority", parseInteger)
    .option("--team <key>", "team key")
    .option("--project <project>", "project id or name")
    .option("--label <label>", "label name or id", collectValues, [])
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        printTemplate(
          createTemplate(cli.context, templateCreateInput(name, options, cli.defaultTeam)),
          options
        );
      })
    );
  template
    .command("list")
    .option("--json", "print JSON output")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        listTemplatesInputSchema.parse({});
        printTemplates(listTemplates(cli.context), optionsWithGlobals(command));
      })
    );
  template
    .command("delete")
    .argument("<name>")
    .option("--json", "print JSON output")
    .action((name, _options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const input = deleteTemplateInputSchema.parse({ name });
        printTemplate(deleteTemplate(cli.context, input.name), optionsWithGlobals(command));
      })
    );

  program
    .command("watch")
    .description("print activity feed events as JSONL")
    .option("--since <cursor>", "activity cursor to start after")
    .option("--once", "print currently available events and exit")
    .option("--interval <ms>", "poll interval in milliseconds", parsePositiveInteger)
    .option("--team <key>", "team key or id")
    .option("--assignee <actor>", "assignee id or handle")
    .option("--limit <number>", "maximum events per poll", parsePositiveInteger)
    .option("--json", "emit JSONL output")
    .action((_options, command) =>
      withContextAsync(command, { requireActor: false }, async (cli) => {
        const options = optionsWithGlobals(command);
        await watchActivity(
          cli.context,
          activitySinceInput(options),
          resolveWatchOptions(options)
        );
      })
    );

  program
    .command("backup")
    .description("write a safe SQLite database backup")
    .option("--output <path>", "backup output path")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);
        const outputPath = resolveBackupPath({
          dbPath: cli.dbPath,
          output: stringOption(options.output),
          clock: cli.context.clock
        });
        const writtenPath = backupDatabase(cli.db, outputPath);

        process.stdout.write(`${writtenPath}\n`);
      })
    );

  program
    .command("export")
    .description("export the workspace snapshot")
    .option("--json", "emit JSON snapshot")
    .option("--output <path>", "write JSON snapshot to a file")
    .action((_options, command) =>
      withContext(command, { requireActor: false }, (cli) => {
        const options = optionsWithGlobals(command);

        if (!options.json) {
          throw new InvalidArgumentError("export requires --json");
        }

        writeExportSnapshot(exportSnapshot(cli.context), stringOption(options.output));
      })
    );

  program
    .command("mcp")
    .description("run the MCP server on stdio")
    .option("--agent <handle>", "agent actor handle")
    .action((_options, command) => {
      const options = optionsWithGlobals(command);
      return runStdioServer({
        dbPath: resolveDbPath(options),
        actor: options.agent
          ? {
              type: "agent",
              handle: String(options.agent)
            }
          : undefined
      });
    });

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    process.exitCode = handleCliError(error);
  }
}

function withContext<T>(
  command: unknown,
  options: { requireActor?: boolean },
  work: (cli: ReturnType<typeof openCliContext>) => T
): T {
  const cli = openCliContext(optionsWithGlobals(command), options);

  try {
    return work(cli);
  } finally {
    cli.close();
  }
}

async function withContextAsync<T>(
  command: unknown,
  options: { requireActor?: boolean },
  work: (cli: ReturnType<typeof openCliContext>) => Promise<T>
): Promise<T> {
  const cli = openCliContext(optionsWithGlobals(command), options);

  try {
    return await work(cli);
  } finally {
    cli.close();
  }
}

function optionsWithGlobals(options: unknown): CommandOptions {
  const command = commandFromOptions(options);
  if (command) {
    return commandChain(command).reduce<CommandOptions>(
      (allOptions, current) => ({
        ...allOptions,
        ...current.opts<CommandOptions>()
      }),
      {}
    );
  }

  return {
    ...((typeof options === "object" && options !== null ? options : {}) as CommandOptions)
  };
}

function commandFromOptions(options: unknown): Command | undefined {
  if (options instanceof Command) {
    return options;
  }

  if (
    typeof options === "object" &&
    options !== null &&
    "parent" in options &&
    options.parent instanceof Command
  ) {
    return options.parent;
  }

  return undefined;
}

function commandChain(command: Command): Command[] {
  const chain: Command[] = [];
  let current: Command | null | undefined = command;

  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  return chain;
}

function normalizeConfigKey(key: string): string {
  if (key === "team") return ConfigKey.DEFAULT_TEAM;
  if (key === "actor") return ConfigKey.DEFAULT_ACTOR;
  return key;
}

function projectCreateInput(name: string | undefined, options: Record<string, unknown>): CreateProjectInput {
  const projectName = stringOption(options.name) ?? name;
  if (!projectName) throw new InvalidArgumentError("project name is required");

  return createProjectInputSchema.parse({
    name: projectName,
    description: stringOption(options.description) ?? stringOption(options.desc) ?? null,
    status: projectStatusOption(options.status),
    leadId: nullableStringOption(options.leadId),
    startDate: nullableStringOption(options.startDate),
    targetDate: nullableStringOption(options.targetDate)
  });
}

function labelCreateInput(name: string, options: Record<string, unknown>): CreateLabelInput {
  return createLabelInputSchema.parse({
    name,
    color: stringOption(options.color),
    group: nullableStringOption(options.group)
  });
}

function actorCreateInput(
  handle: string,
  name: string,
  options: Record<string, unknown>
): CreateActorInput {
  return createActorInputSchema.parse({
    handle,
    name,
    type: stringOption(options.type)
  });
}

function cycleCreateInput(
  name: string | undefined,
  options: Record<string, unknown>,
  defaultTeam?: string
): CreateCycleInput {
  return createCycleInputSchema.parse(omitUndefined({
    team: stringOption(options.team) ?? defaultTeam,
    number: numberOption(options.number),
    name: stringOption(options.name) ?? name,
    startsAt: stringOption(options.startsAt),
    endsAt: stringOption(options.endsAt)
  }));
}

function cycleListInput(options: Record<string, unknown>, defaultTeam?: string) {
  return listCyclesInputSchema.parse(omitUndefined({
    team: stringOption(options.team) ?? defaultTeam
  }));
}

function projectUpdateInput(options: Record<string, unknown>): UpdateProjectInput {
  return updateProjectInputSchema.parse(omitUndefined({
    name: stringOption(options.name),
    description: stringOption(options.description) ?? stringOption(options.desc),
    status: projectStatusOption(options.status),
    leadId: nullableStringOption(options.leadId),
    startDate: nullableStringOption(options.startDate),
    targetDate: nullableStringOption(options.targetDate)
  }));
}

function issueCreateInput(
  title: string | undefined,
  options: Record<string, unknown>,
  defaultTeam?: string
): CreateIssueInput {
  const issueTitle = stringOption(options.title) ?? title;
  if (!issueTitle) throw new InvalidArgumentError("issue title is required");

  return createIssueInputSchema.parse({
    title: issueTitle,
    description: stringOption(options.description) ?? stringOption(options.desc) ?? null,
    team: stringOption(options.team) ?? defaultTeam,
    state: stringOption(options.state),
    priority: numberOption(options.priority),
    assignee: nullableStringOption(options.assignee),
    project: nullableStringOption(options.project),
    cycle: cycleOption(options.cycle),
    parent: nullableStringOption(options.parent),
    labels: stringArrayOption(options.label)
  });
}

function issueCreateTemplateOverrides(
  title: string | undefined,
  options: Record<string, unknown>
): CreateIssueFromTemplateOverrides {
  return createIssueFromTemplateOverridesSchema.parse(omitUndefined({
    title: stringOption(options.title) ?? title,
    description: stringOption(options.description) ?? stringOption(options.desc),
    team: stringOption(options.team),
    state: stringOption(options.state),
    priority: numberOption(options.priority),
    assignee: nullableStringOption(options.assignee),
    project: nullableStringOption(options.project),
    cycle: cycleOption(options.cycle),
    parent: nullableStringOption(options.parent),
    labels: stringArrayOption(options.label)
  }));
}

function issueListFilters(options: Record<string, unknown>, defaultTeam?: string): ListIssueFilters {
  const project = options.project === false ? null : nullableStringOption(options.project);
  const assignee = options.unassigned === true ? null : nullableStringOption(options.assignee);

  return listIssueFiltersSchema.parse(omitUndefined({
    state: stringOption(options.state),
    assignee,
    project,
    team: stringOption(options.team) ?? defaultTeam,
    label: stringOption(options.label),
    cycle: cycleOption(options.cycle),
    priority: numberOption(options.priority),
    limit: numberOption(options.limit),
    includeArchived: booleanOption(options.includeArchived)
  }));
}

function issueListInput(
  options: Record<string, unknown>,
  defaultTeam?: string
): ListIssuesWithViewInput {
  return listIssuesWithViewInputSchema.parse(omitUndefined({
    view: stringOption(options.view),
    filters: issueListFilters(options, defaultTeam)
  }));
}

function savedViewCreateInput(
  name: string,
  options: Record<string, unknown>,
  defaultTeam?: string
): CreateSavedViewInput {
  return createSavedViewInputSchema.parse({
    name,
    filters: issueListFilters(options, defaultTeam),
    description: stringOption(options.description) ?? stringOption(options.desc) ?? null
  });
}

function templateCreateInput(
  name: string,
  options: Record<string, unknown>,
  defaultTeam?: string
): CreateTemplateInput {
  return createTemplateInputSchema.parse(omitUndefined({
    name,
    title: stringOption(options.title),
    description: stringOption(options.description) ?? stringOption(options.desc),
    priority: numberOption(options.priority),
    team: stringOption(options.team) ?? defaultTeam,
    project: nullableStringOption(options.project),
    labels: stringArrayOption(options.label)
  }));
}

function issueSearchInput(
  query: string,
  options: Record<string, unknown>,
  defaultTeam?: string
): SearchIssuesInput {
  return searchInputSchema.parse(omitUndefined({
    query,
    team: stringOption(options.team) ?? defaultTeam,
    limit: numberOption(options.limit)
  }));
}

function issueUpdateInput(options: Record<string, unknown>): UpdateIssueInput {
  const assignee = options.unassigned === true ? null : nullableStringOption(options.assignee);
  const project = options.project === false ? null : nullableStringOption(options.project);

  return updateIssueInputSchema.parse(omitUndefined({
    title: stringOption(options.title),
    description: stringOption(options.description) ?? stringOption(options.desc),
    priority: numberOption(options.priority),
    assignee,
    project,
    cycle: cycleOption(options.cycle),
    parent: parentOption(options.parent),
    labels: stringArrayOption(options.label),
    removeLabels: stringArrayOption(options.removeLabel),
    estimate: numberOption(options.estimate),
    dueDate: nullableStringOption(options.dueDate)
  }));
}

function issueAssignInput(
  identifier: string,
  actorArgument: string | undefined,
  options: Record<string, unknown>,
  defaultActorId: string | undefined
): AssignIssueInput {
  const hasActorArgument = actorArgument !== undefined;
  const useDefaultActor = options.me === true;
  const clearAssignee = options.none === true;
  const targetCount = [hasActorArgument, useDefaultActor, clearAssignee].filter(Boolean).length;

  if (targetCount !== 1) {
    throw new InvalidArgumentError("provide exactly one of <actor>, --me, or --none");
  }

  return assignIssueInputSchema.parse({
    identifier,
    actor: clearAssignee ? null : useDefaultActor ? defaultActorId : actorArgument
  });
}

function issueCommentInput(
  identifier: string,
  body: string,
  options: Record<string, unknown>
): AddCommentInput {
  return addCommentInputSchema.parse(omitUndefined({
    issue: identifier,
    body,
    parent: nullableStringOption(options.parent)
  }));
}

function issueLinkInput(
  identifier: string,
  urlArgument: string | undefined,
  options: Record<string, unknown>
): AddAttachmentInput {
  return linkIssueInputSchema.parse(omitUndefined({
    issue: identifier,
    kind: stringOption(options.kind) ?? "link",
    title: nullableStringOption(options.title),
    url: stringOption(options.url) ?? urlArgument,
    repoPath: stringOption(options.repo),
    remote: nullableStringOption(options.remote),
    branchName: stringOption(options.branch),
    commitSha: stringOption(options.sha)
  }));
}

function activitySinceInput(options: Record<string, unknown>): ListActivitySinceInput {
  return listActivitySinceInputSchema.parse(omitUndefined({
    cursor: stringOption(options.since),
    team: stringOption(options.team),
    assignee: stringOption(options.assignee),
    limit: numberOption(options.limit)
  }));
}

export function resolveWatchOptions(options: Record<string, unknown>): {
  intervalMs: number;
  once: boolean;
} {
  return {
    intervalMs: numberOption(options.interval) ?? 1000,
    once: booleanOption(options.once) === true
  };
}

async function watchActivity(
  context: ServiceContext,
  input: ListActivitySinceInput,
  options: { intervalMs: number; once: boolean }
): Promise<void> {
  let cursor = input.cursor;

  while (true) {
    const result = listActivitySince(context, { ...input, cursor });
    printActivityEvents(result.events);
    cursor = result.cursor;

    if (options.once) {
      return;
    }

    await delay(options.intervalMs);
  }
}

function writeExportSnapshot(snapshot: unknown, outputPath: string | undefined): void {
  const serialized = `${JSON.stringify(snapshot)}\n`;

  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }

  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serialized, "utf8");
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new InvalidArgumentError("expected an integer");
  }

  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed <= 0) {
    throw new InvalidArgumentError("expected a positive integer");
  }

  return parsed;
}

function projectStatusOption(value: unknown): CreateProjectInput["status"] | undefined {
  if (value === undefined) return undefined;
  const status = stringOption(value);

  if (!status) {
    throw new InvalidArgumentError("expected a valid project status");
  }

  const parsed = projectStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new InvalidArgumentError("expected a valid project status");
  }

  return parsed.data;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableStringOption(value: unknown): string | null | undefined {
  return value === null ? null : stringOption(value);
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function cycleOption(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function parentOption(value: unknown): string | null | undefined {
  const parent = nullableStringOption(value);
  return typeof parent === "string" && parent.toLowerCase() === "none" ? null : parent;
}

function booleanOption(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayOption(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function omitUndefined<T extends Record<string, unknown>>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as T;
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (entrypoint) {
  void run();
}
