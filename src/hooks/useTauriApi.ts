import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, EngineStatus, KeychainStatus, SystemStats } from "@statusforge/types";
import { loadSystemPrefs } from "@statusforge/systemPrefs";

export async function tauriApi(
  command: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    return await invoke(command, args);
  } catch (err) {
    return { error: String(err) };
  }
}

export async function fetchEngineStatus(): Promise<EngineStatus> {
  const data = (await tauriApi("get_engine_status")) as EngineStatus | { error: string };
  if ("error" in data && data.error) {
    return {
      running: false,
      game_title: "",
      process_name: "",
      is_playing: false,
      genre: "",
      developer: "",
      publisher: "",
      release_date: "",
      cover_url: "",
      overlayToken: "",
    };
  }
  return data as EngineStatus;
}

export async function fetchOverlayToken(): Promise<string> {
  const t = await tauriApi("get_overlay_token");
  return typeof t === "string" ? t : "Unknown";
}

export async function fetchConfig(): Promise<AppConfig | null> {
  const res = await tauriApi("export_config");
  if (res && typeof res === "object" && !("error" in res)) {
    return res as AppConfig;
  }
  return null;
}

export async function saveConfig(config: AppConfig): Promise<string> {
  // The Rust command is `fn import_config(payload: ConfigImportPayload)` — a
  // single named parameter, so Tauri's IPC requires the invoke args to have a
  // `payload` key wrapping the whole body, not `config`/`backup` at the top
  // level (that fails with "missing required key payload" on every save).
  const res = await tauriApi("import_config", {
    payload: {
      config,
      // backup: keep a Config.json.bak of the prior file (System > Automatic Backups)
      backup: loadSystemPrefs().configBackupEnabled,
    },
  });
  if (typeof res === "string") return res;
  // Surface the real backend error (e.g. validation failure) instead of a
  // generic message, so the user knows why the save was rejected.
  const err =
    res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
  return err ? `Failed to save: ${err}` : "Failed to save";
}

export async function getSystemStats(): Promise<SystemStats | null> {
  const res = await tauriApi("get_system_stats");
  if (res && typeof res === "object" && !("error" in res)) {
    return res as SystemStats;
  }
  return null;
}

export async function getKeychainStatus(): Promise<KeychainStatus> {
  try {
    const map = await invoke<Record<string, string>>("get_all_keychain_tokens");
    const keys = Object.keys(map);
    return { stored: keys, count: keys.length };
  } catch {
    return { stored: [], count: 0 };
  }
}
