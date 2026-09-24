import { createHash } from "node:crypto";

// Key-order-independent serialization and digest. Shared by run preview fingerprints and
// work-context fingerprints; the output must stay byte-identical to keep stored preview
// fingerprints comparable.
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
