import type { ToolProfile } from "@issue-tracker/core";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

/** Advertisement only: every tool call still reaches the SDK's normal handler. */
export class ToolProfileTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private readonly listRequests = new Set<RequestId>();
  constructor(private readonly inner: Transport, private readonly profile: ToolProfile) {}
  get sessionId() { return this.inner.sessionId; }
  setProtocolVersion(version: string) { this.inner.setProtocolVersion?.(version); }
  async start() {
    this.inner.onclose = () => { this.listRequests.clear(); this.onclose?.(); };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      if ("method" in message && message.method === "tools/list" && "id" in message) this.listRequests.add(message.id);
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    if ("id" in message && message.id !== undefined && this.listRequests.delete(message.id) && "result" in message && Array.isArray(message.result.tools)) {
      const tools = message.result.tools.filter((tool: { _meta?: Record<string, unknown> }) => {
        const groups = tool._meta?.["issue-tracker/groups"];
        return this.profile === "full" || this.profile === "admin" || (Array.isArray(groups) && (groups.includes(this.profile) || (this.profile === "orchestration" && groups.includes("coding"))));
      });
      message = { ...message, result: { ...message.result, tools } };
    }
    await this.inner.send(message, options);
  }
  async close() { this.listRequests.clear(); await this.inner.close(); }
}
