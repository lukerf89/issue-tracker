#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import pc from "picocolors";

export function createProgram(): Command {
  return new Command()
    .name("tracker")
    .description("Local-first issue tracker CLI")
    .version("0.0.0")
    .addHelpText("after", `\n${pc.dim("More commands arrive after the Phase 0 scaffold.")}`);
}

export function run(argv: string[] = process.argv): void {
  createProgram().parse(argv);
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (entrypoint) {
  run();
}
