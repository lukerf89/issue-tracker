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

export const participantResultSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { enum: ["info", "warning", "blocking"] },
          file: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          summary: { type: "string" },
          evidence: { type: "string" }
        },
        required: ["severity", "summary", "evidence"],
        additionalProperties: false
      }
    },
    verifiedTestsPassed: { type: "boolean" },
    riskNotes: { type: "array", items: { type: "string" } }
  },
  required: ["role", "summary", "files", "tests", "risks", "findings", "verifiedTestsPassed", "riskNotes"],
  additionalProperties: false
} as const;

export function isParticipantResult(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const allowed = new Set(["role", "summary", "files", "tests", "risks", "findings", "verifiedTestsPassed", "riskNotes"]);
  if (Object.keys(result).some((key) => !allowed.has(key))) return false;
  if (typeof result.role !== "string" || typeof result.summary !== "string" || typeof result.verifiedTestsPassed !== "boolean") return false;
  if (![result.files, result.tests, result.risks, result.riskNotes].every((value) => Array.isArray(value) && value.every((item) => typeof item === "string"))) return false;
  return Array.isArray(result.findings) && result.findings.every((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const value = finding as Record<string, unknown>;
    return ["info", "warning", "blocking"].includes(String(value.severity))
      && typeof value.summary === "string"
      && typeof value.evidence === "string"
      && (value.file === undefined || value.file === null || typeof value.file === "string")
      && (value.location === undefined || value.location === null || typeof value.location === "string");
  });
}

export function providerEnvironment(allowed: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { ...base, ...allowed };
}
