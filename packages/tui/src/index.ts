import { render } from "ink";
import { createElement } from "react";

import type { ServiceContext } from "@issue-tracker/core";

import { LinekeeperApp } from "./app.js";

export { commandFromMode, executeLinekeeperCommand, loadLinekeeperData, parseFilterInput } from "./data.js";
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
}

export async function runLinekeeperTui(options: RunLinekeeperTuiOptions): Promise<void> {
  const instance = render(createElement(LinekeeperApp, options));
  await instance.waitUntilExit();
}
