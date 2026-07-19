import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writePrivateLog(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  return { path, sha256: sha256File(path) };
}

export function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`Artifact ${path} does not exist.`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
