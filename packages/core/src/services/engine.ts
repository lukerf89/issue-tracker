import { z } from "zod";

import { AppError, AppErrorCode } from "../errors.js";
import { engineCatalogSchema, type EngineCatalog } from "../schemas/engine.js";

export interface EngineCatalogRuntime {
  read(path: string): unknown;
  executableAvailable(executable: string): boolean;
}

export function resolveEngineCatalogPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configRoot = environment.XDG_CONFIG_HOME ?? resolve(environment.HOME ?? "", ".config");
  return resolve(configRoot, "issue-tracker", "engines.json");
}

export function createNodeEngineCatalogRuntime(environment: NodeJS.ProcessEnv = process.env): EngineCatalogRuntime {
  return {
    read(path) {
      try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
      catch (error) { throw new AppError(AppErrorCode.VALIDATION_FAILED, `Unable to read engine catalog ${path}.`, { message: error instanceof Error ? error.message : String(error) }); }
    },
    executableAvailable(executable) {
      const candidates = isAbsolute(executable) ? [executable] : (environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, executable));
      return candidates.some((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
    }
  };
}

export interface EngineDiagnostic {
  engine: string;
  valid: boolean;
  errors: string[];
  definition: Omit<EngineCatalog["engines"][string], "envNames"> & { envNames: string[] } | null;
}

export function loadEngineCatalog(path: string, runtime: EngineCatalogRuntime): EngineCatalog {
  return engineCatalogSchema.parse(runtime.read(path));
}

export function validateEngineCatalog(catalog: unknown, runtime: Pick<EngineCatalogRuntime, "executableAvailable">): EngineDiagnostic[] {
  const parsed = engineCatalogSchema.safeParse(catalog);
  if (!parsed.success) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Engine catalog is invalid.", { issues: z.treeifyError(parsed.error) });
  return Object.entries(parsed.data.engines).sort(([left], [right]) => left.localeCompare(right)).map(([name, engine]) => ({
    engine: name,
    valid: runtime.executableAvailable(engine.executable),
    errors: runtime.executableAvailable(engine.executable) ? [] : [`Executable ${engine.executable} is unavailable.`],
    definition: { ...engine, envNames: engine.envNames.map((envName) => `${envName}=<inherited>`) }
  }));
}

export function getEngine(catalog: EngineCatalog, name: string) {
  const engine = catalog.engines[name];
  if (!engine) throw new AppError(AppErrorCode.VALIDATION_FAILED, `Engine ${name} is not configured.`, { engine: name });
  return engine;
}
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
