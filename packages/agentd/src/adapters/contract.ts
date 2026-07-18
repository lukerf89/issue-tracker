import { participantResultJsonSchema, participantResultSchema } from "@issue-tracker/core";

export interface ProviderCapabilities {
  resume: boolean;
  redirect: boolean;
  interactivePermissions: boolean;
  structuredOutput: boolean;
  childParticipants: boolean;
  usage: boolean;
}

export interface ProviderLaunch {
  participantId: string;
  role: string;
  executable: string;
  model: string;
  workingDirectory: string;
  prompt: string;
  options?: Record<string, unknown>;
  env?: Record<string, string>;
  onProcess?: (pid: number) => void;
}

export interface ProviderEvent {
  providerEventId: string;
  type: string;
  data: Record<string, unknown>;
  progress: boolean;
}

export interface ProviderResult {
  exitCode: number | null;
  sessionId: string | null;
  actualModel: string | null;
  structuredResult: Record<string, unknown> | null;
  events: ProviderEvent[];
  rawLog: string;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  probe(executable: string): Promise<{ installed: boolean; authenticated: boolean; diagnostic: string | null }>;
  run(launch: ProviderLaunch, signal?: AbortSignal): Promise<ProviderResult>;
  resume?(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal): Promise<ProviderResult>;
  redirect?(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal): Promise<ProviderResult>;
}

export const participantResultOutputSchema = participantResultJsonSchema;

export function isParticipantResult(value: unknown): value is Record<string, unknown> {
  return participantResultSchema.safeParse(value).success;
}

export function providerEnvironment(allowed: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { ...base, ...allowed };
}
