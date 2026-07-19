import { participantResultJsonSchema, participantResultSchema, type ParticipantFailureCode } from "@issue-tracker/core";

type JsonSchema = Record<string, unknown>;

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
  /**
   * Routes provider permission prompts to a durable tracker request a human can answer. Supplied
   * for adapters whose capabilities declare `interactivePermissions`; without it those adapters
   * cannot perform mutating work in a noninteractive session.
   */
  permissionHook?: { dbPath: string; runId: string; timeoutMs?: number } | null;
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
  failure?: { code: ParticipantFailureCode; message: string } | null;
}

export interface ProviderProbe {
  executable: string;
  model: string;
  options?: Record<string, unknown>;
  env?: Record<string, string>;
}

export interface ProviderHealth {
  installed: boolean;
  authenticated: boolean;
  modelAccessible: boolean;
  diagnosticCode: string | null;
  remediation: string | null;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  probe(input: ProviderProbe): Promise<ProviderHealth>;
  run(launch: ProviderLaunch, signal?: AbortSignal): Promise<ProviderResult>;
  resume?(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal): Promise<ProviderResult>;
  redirect?(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal): Promise<ProviderResult>;
}

export function participantResultOutputSchema(provider: "claude-code" | "codex", role: string): JsonSchema {
  const schema = structuredClone(participantResultJsonSchema) as JsonSchema;
  delete schema.$schema;
  const properties = schema.properties as Record<string, JsonSchema>;
  properties.role = { type: "string", enum: [role] };
  const required = schema.required as string[];
  if (role === "planner") required.push("risk", "estimatedSize");
  else {
    delete properties.risk;
    delete properties.estimatedSize;
  }
  if (provider === "codex") makeStrict(properties, schema);
  return schema;
}

function makeStrict(properties: Record<string, JsonSchema>, schema: JsonSchema) {
  schema.additionalProperties = false;
  schema.required = Object.keys(properties);
  for (const child of Object.values(properties)) makeStrictNode(child);
}

function makeStrictNode(schema: JsonSchema) {
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const properties = schema.properties as Record<string, JsonSchema>;
    schema.additionalProperties = false;
    schema.required = Object.keys(properties);
    for (const child of Object.values(properties)) makeStrictNode(child);
  }
  if (schema.items && typeof schema.items === "object") makeStrictNode(schema.items as JsonSchema);
  if (Array.isArray(schema.anyOf)) for (const child of schema.anyOf) if (child && typeof child === "object") makeStrictNode(child as JsonSchema);
}

export function isParticipantResult(value: unknown): value is Record<string, unknown> {
  return participantResultSchema.safeParse(value).success;
}

export function providerEnvironment(allowed: Record<string, string> = {}): NodeJS.ProcessEnv {
  // HOME/USER/LOGNAME are required for provider credential lookup: Claude Code resolves its
  // OAuth session through the macOS Keychain, which reports an unrefreshable session when the
  // calling process has no user identity. Omitting them surfaces as a spurious auth expiry.
  const base = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { ...base, ...allowed };
}

export function providerFailure(exitCode: number | null, output: string): { code: ParticipantFailureCode; message: string } | null {
  if (exitCode === 0) return null;
  const normalized = output.toLowerCase();
  if (/auth|oauth|credential|login|unauthorized|expired/.test(normalized)) return { code: "provider_authentication_failed", message: "Provider authentication failed." };
  if (/model.*(not found|unavailable|access|invalid)|does not have access/.test(normalized)) return { code: "provider_model_unavailable", message: "The configured provider model is unavailable." };
  if (/schema|additionalproperties|json_schema|output format/.test(normalized)) return { code: "provider_schema_rejected", message: "The provider rejected the structured-output schema." };
  if (exitCode === null) return { code: "provider_process_crashed", message: "The provider process ended without an exit status." };
  return { code: "provider_exit_nonzero", message: `The provider process exited with status ${exitCode}.` };
}
