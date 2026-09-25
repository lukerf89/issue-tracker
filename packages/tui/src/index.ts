import { render } from "ink";
import { createElement } from "react";

import type { ServiceContext } from "@issue-tracker/core";

import { LinekeeperApp } from "./app.js";
import { prepareLinekeeperStartup, type LinekeeperStartupOptions } from "./data.js";

export {
  commandFromMode,
  executeLinekeeperCommand,
  loadLinekeeperData,
  parseFilterInput,
  prepareLinekeeperStartup,
  restoreLinekeeperData,
  startupLoadOptions,
  type LinekeeperStartup,
  type LinekeeperStartupOptions
} from "./data.js";
export { mapKeyToLinekeeperAction } from "./keys.js";
export {
  initialLinekeeperState,
  linekeeperSections,
  reduceLinekeeperState,
  selectedSection
} from "./state.js";

export interface RunLinekeeperTuiOptions {
  context: ServiceContext;
  dbPath: string;
  defaultTeam?: string;
  /** Scope from the command line; validated by core before the UI renders. */
  startup?: LinekeeperStartupOptions;
}

export async function runLinekeeperTui(options: RunLinekeeperTuiOptions): Promise<void> {
  const prepared = prepareLinekeeperStartup(options.context, {
    defaultTeam: options.defaultTeam,
    startup: options.startup
  });
  const instance = render(createElement(LinekeeperApp, {
    context: options.context,
    dbPath: options.dbPath,
    defaultTeam: options.defaultTeam,
    startup: prepared
  }));
  await instance.waitUntilExit();
}
