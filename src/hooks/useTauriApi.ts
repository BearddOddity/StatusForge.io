import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, EngineStatus, KeychainStatus } from "@/types";


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
      widgetToken: "",
    };
  }
  return data as EngineStatus;
}

export async function fetchWidgetToken(): Promise<string> {
  const t = await tauriApi("get_widget_token");
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
  const res = await tauriApi("import_config", { config });
  return typeof res === "string" ? res : "Failed to save";
}

export async function getDetectionMode(): Promise<string> {
  const res = await tauriApi("get_detection_mode");
  return typeof res === "string" ? res : "python";
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
