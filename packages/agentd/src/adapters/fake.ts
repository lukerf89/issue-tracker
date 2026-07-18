import type { ProviderAdapter, ProviderLaunch, ProviderResult } from "./contract.js";

export interface FakeProviderScript {
  result: Omit<ProviderResult, "rawLog"> | ((launch: ProviderLaunch) => Omit<ProviderResult, "rawLog">);
  rawLog?: string;
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly name = "fake";
  readonly capabilities = { resume: true, redirect: true, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };
  readonly launches: ProviderLaunch[] = [];

  constructor(private readonly scripts: FakeProviderScript[]) {}

  async probe() { return { installed: true, authenticated: true, diagnostic: null }; }

  async run(launch: ProviderLaunch): Promise<ProviderResult> {
    this.launches.push(launch);
    const script = this.scripts.shift();
    if (!script) throw new Error(`No fake provider script remains for ${launch.role}.`);
    const result = typeof script.result === "function" ? script.result(launch) : script.result;
    return { ...result, rawLog: script.rawLog ?? result.events.map((event) => JSON.stringify(event)).join("\n") };
  }

  async resume(launch: ProviderLaunch): Promise<ProviderResult> { return await this.run(launch); }
  async redirect(launch: ProviderLaunch): Promise<ProviderResult> { return await this.run(launch); }
}
