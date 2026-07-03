import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked before importing the module under test so the mock is in place
// when useTauriApi.ts's top-level `import { invoke }` resolves.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { saveConfig } from "./useTauriApi";
import type { AppConfig } from "@/types";

const fakeConfig = {
  api_keys: { steamgrid: "", rawg: "", igdb_client: "", igdb_secret: "", igdb_token: "" },
  engine_settings: {} as AppConfig["engine_settings"],
  broadcaster: {} as AppConfig["broadcaster"],
} as AppConfig;

describe("saveConfig", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("sends invoke args wrapped under `payload`, matching the Rust command's single named parameter", async () => {
    // Regression test for a real bug: import_config's Rust signature is
    // `fn import_config(payload: ConfigImportPayload)` — Tauri's IPC layer
    // requires the invoke args object to have a key literally named
    // "payload". Sending { config, backup } at the top level (the original,
    // broken shape) fails every save with "missing required key payload".
    invokeMock.mockResolvedValue("Config saved successfully");

    await saveConfig(fakeConfig);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("import_config");
    expect(args).toHaveProperty("payload");
    expect(args).not.toHaveProperty("config"); // must NOT be top-level
    expect(args).not.toHaveProperty("backup"); // must NOT be top-level
    expect((args as { payload: { config: unknown } }).payload.config).toBe(fakeConfig);
    expect(typeof (args as { payload: { backup: unknown } }).payload.backup).toBe("boolean");
  });

  it("surfaces the real backend error instead of a generic message", async () => {
    invokeMock.mockResolvedValue({ error: "Config validation failed: scan_interval must be >= 2" });

    const result = await saveConfig(fakeConfig);

    expect(result).toBe("Failed to save: Config validation failed: scan_interval must be >= 2");
  });

  it("returns the backend's success string as-is", async () => {
    invokeMock.mockResolvedValue("Config saved successfully");

    const result = await saveConfig(fakeConfig);

    expect(result).toBe("Config saved successfully");
  });
});
