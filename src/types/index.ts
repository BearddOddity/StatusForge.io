// ─── Shared TypeScript interfaces for StatusForge.io ───

export interface GameInfo {
  title: string;
  process: string;
  platform: string;
}

export interface EngineStatusData {
  is_playing: boolean;
  game_title: string;
  process_name: string;
  start_time: number;
  cover_url: string;
  release_date: string;
  genre: string;
  publisher: string;
  developer: string;
  last_pulse: number;
  pending_bundle: boolean;
  bundle_options: GameInfo[];
}

export interface EngineStatus {
  running: boolean;
  game_title: string;
  process_name: string;
  is_playing: boolean;
  genre: string;
  developer: string;
  publisher: string;
  release_date: string;
  cover_url: string;
  widgetToken: string;
}

export interface ApiKeys {
  steamgrid: string;
  rawg: string;
  igdb_client: string;
  igdb_secret: string;
  igdb_token: string;
}

export type DetectionMode = "python" | "native" | "spark";

export interface DetectionConfig {
  mode: DetectionMode;
  python_fallback: boolean;
  scan_interval_secs: number;
  dev_tools_enabled: boolean;
  closed_beta_channel: boolean;
}

export interface EngineSettings {
  idle_category: string;
  sb_port: number;
  scan_interval: number;
  grace_period: number;
  widget_poll_rate: number;
  safe_mode: boolean;
  auto_push: boolean;
  widget_fade_timer: number;
  strict_forge_mode: boolean;
  sb_action_name: string;
  widget_token: string;
  // Spark / dual-PC
  spark_pin: string;
  // Detection pipeline
  emulator_detection: boolean;
  ram_threshold: number;
  process_filter_bypass: boolean;
  confidence_threshold: number;
  // Behavior Trap toggles
  trap_chromium: boolean;
  trap_cmdline: boolean;
  trap_ui_framework: boolean;
  trap_geometry: boolean;
  // Confidence scoring toggles (each adds 0.1–0.4 to score)
  score_engine_dna: boolean;
  score_fullscreen: boolean;
  score_window_title: boolean;
  score_ram: boolean;
}

export type RoutingMode = "streamer_bot" | "native";

export interface BroadcasterConfig {
  routing_mode: RoutingMode;
  twitch_client: string;
  twitch_secret: string;
  twitch_token: string;
  twitch_refresh: string;
  twitch_broadcaster_id: string;
  kick_client: string;
  kick_secret: string;
  kick_channel_id: string;
  kick_token: string;
  kick_refresh: string;
}

export interface AppConfig {
  api_keys: ApiKeys;
  engine_settings: EngineSettings;
  broadcaster: BroadcasterConfig;
  detection: DetectionConfig;
}

export interface ForgeLibraryEntry {
  title: string;
  genre: string;
  release_year: string;
  developer: string;
  publisher: string;
  cover_url: string;
  twitch_id: string;
  kick_id: string;
  igdb_id: string;
  steam_id: string;
  rawg_id: string;
  discord_app_id: string;
  gog_id: string;
  itch_id: string;
  sgdb_id: string;
  xbox_title_id: string;
  epic_id: string;
  executables?: string;
}

export interface ForgeDatabase {
  delisted_apps: string[];
  listed_apps: Record<string, string>;
  library: Record<string, ForgeLibraryEntry>;
}

export type ViewId =
  | "dashboard"
  | "library"
  | "settings"
  | "dev";

export type SettingsSubTab = "engine" | "routing" | "api" | "system" | "theme" | "about";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export interface KeychainStatus {
  stored: string[];
  count: number;
}

export interface ExiledApp {
  process: string;
  exiled_at?: string;
}

export interface ThemeSettings {
  accentColor: string;
  bgColor: string;
  bgOpacity: number;
  bgBlur: number;
  bgImage: string;
  panelOpacity: number;
  borderRadius: "sharp" | "soft" | "rounded";
  fontScale: number;
  animationsEnabled: boolean;
  holoEffects: boolean;
  density: "compact" | "default" | "spacious";
  sidebarIconOnly: boolean;
}
