import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

export function identifier(key: string, n: number): string {
  return `${key}-${n}`;
}
