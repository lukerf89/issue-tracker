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
  required: ["role", "summary"],
  additionalProperties: false
} as const;
