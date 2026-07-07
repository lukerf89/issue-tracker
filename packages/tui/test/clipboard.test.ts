import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock
}));

const { copyIdentifierToClipboard } = await import("../src/app.js");

describe("copyIdentifierToClipboard", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("falls back across clipboard commands until one succeeds", () => {
    spawnSyncMock
      .mockReturnValueOnce({ error: new Error("missing"), status: null })
      .mockReturnValueOnce({ status: 0 });

    expect(copyIdentifierToClipboard("ENG-1")).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual([
      "pbcopy",
      "wl-copy"
    ]);
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({
      input: "ENG-1",
      stdio: ["pipe", "ignore", "ignore"]
    });
  });

  it("reports unavailable when no clipboard command succeeds", () => {
    spawnSyncMock.mockReturnValue({ status: 1 });

    expect(copyIdentifierToClipboard("ENG-1")).toBe(false);
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual([
      "pbcopy",
      "wl-copy",
      "xclip",
      "clip"
    ]);
  });

  it("does not probe clipboard commands without an identifier", () => {
    expect(copyIdentifierToClipboard("")).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
