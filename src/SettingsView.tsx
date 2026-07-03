import React, { useState, useEffect, useRef, useCallback } from "react";
import type {
  EngineStatus,
  AppConfig,
  SettingsSubTab,
  ToastType,
  ApiKeys,
} from "@/types";
import type { KeychainStatus } from "@/types";
import {
  fetchWidgetToken,
  getKeychainStatus,
  saveConfig,
  tauriApi,
} from "@/hooks/useTauriApi";
import {
  SubTabBtn,
  CollapsibleSection,
  Toggle,
  SettingsRow,
  SettingsInput,
  GlassSelect,
  SettingsPanel,
  EditRemoveButtons,
} from "@/components/SettingsComponents";
import OAuthConnectModal from "@/components/OAuthConnectModal";
import {
  type ThemePrefs,
  loadThemePrefs,
  saveThemePrefs,
  applyThemePrefs,
} from "@/theme";
import {
  type SystemPrefs,
  defaultSystemPrefs,
  loadSystemPrefs,
  saveSystemPrefs,
} from "@/systemPrefs";

// ─── Engine Sub-tab ─────────────────────────────────────────────────────────
function EngineSubTab({
  engineStatus,
  onRefresh,
  toast,
  devUnlocked,
}: {
  engineStatus: EngineStatus;
  onRefresh: () => void;
  toast: (msg: string, type?: ToastType) => void;
  devUnlocked: boolean;
}) {
  const [widgetToken, setWidgetToken] = useState("Loading...");
  const [keychainInfo, setKeychainInfo] = useState<KeychainStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<string>("windows");
  const skipSave = useRef(false);

  const [oauthModal, setOauthModal] = useState<{ platform: "twitch" | "kick"; url: string } | null>(null);

  const loadConfig = useCallback(async () => {
    skipSave.current = true;
    const res = await tauriApi("export_config");
    // A fresh install (no Config.json yet) returns {} — fall back to defaults
    // so section accesses (engine_settings, api_keys, …) never crash.
    if (res && typeof res === "object" && !("error" in res) && "engine_settings" in res) {
      setConfig(res as AppConfig);
    } else {
      setConfig(defaultConfig);
    }
    setTimeout(() => { skipSave.current = false; }, 500);
  }, []);

  useEffect(() => {
    fetchWidgetToken()
      .then((t) => setWidgetToken(t))
      .catch(() => setWidgetToken(defaultConfig.engine_settings.widget_token));
    getKeychainStatus()
      .then((s) => setKeychainInfo(s))
      .catch(() =>
        setKeychainInfo({ stored: ["twitch_token", "kick_token"], count: 2 })
      );
    loadConfig();
    // Detect platform to grey out incompatible options
    tauriApi("get_platform")
      .then((p) => setPlatform(typeof p === "string" ? p : "windows"))
      .catch(() => setPlatform("windows"));
    tauriApi("get_autostart")
      .then((v) => setAutostart(v === true))
      .catch(() => setAutostart(false));
  }, [loadConfig]);

  const [autostart, setAutostart] = useState(false);
  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await tauriApi("set_autostart", { enabled: next });
      setAutostart(next);
      toast(next ? "StatusForge will start on login" : "Autostart disabled", "success");
    } catch (e) {
      toast(`Autostart failed: ${e}`, "error");
    }
  };

  useEffect(() => {
    if (!config || skipSave.current) return;
    const timer = setTimeout(async () => {
      try {
        const res = await saveConfig(config);
        toast(res, res.includes("success") ? "success" : "error");
      } catch {
        toast("Dev mode: config saved to memory (Tauri not connected)", "info");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [config]);

  const setEngine = (key: string, value: string | number | boolean) => {
    setConfig((prev) => ({
      ...prev!,
      engine_settings: {
        ...prev!.engine_settings,
        [key]: value,
      },
    }));
  };

  const [trapsOpen, setTrapsOpen] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [showPipelineAdvanced, setShowPipelineAdvanced] = useState(false);

  const regenerateWidgetToken = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const token = Array.from(
      { length: 22 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    setEngine("widget_token", token);
    setWidgetToken(token);
    toast("Widget token regenerated — save to apply", "info");
  };

  return (
    <div>
      {/* Control Panel */}
      <CollapsibleSection
        title="Control Panel"
        description="View engine status and manage the widget token."
        icon="⚡"
        defaultOpen={true}
        badge={
          <span
            className={`text-[10px] px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5 border transition-all duration-300 ${
              engineStatus.running
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-red-500/10 border-red-500/20 text-red-400"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                engineStatus.running ? "bg-green-400 animate-pulse" : "bg-red-400"
              }`}
            />
            {engineStatus.running ? "ONLINE" : "OFFLINE"}
          </span>
        }
      >
        <p className="text-xs text-white/50 mb-5 leading-relaxed">
          The detection engine runs on port 53735. Mode: <strong className="text-white/70">Native (Rust)</strong>.
          Platform: <strong className="text-white/70">{platform}</strong>.
          {platform === "macos" && (
            <span className="text-yellow-400/70"> macOS requires the Screen Recording permission to read window titles.</span>
          )}
        </p>
        <div className="flex items-center gap-3 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <p className="text-white/60 text-xs flex-1">
            Widget Token:{" "}
            <code className="bg-black/40 px-1.5 py-0.5 rounded font-mono text-white/90">
              {widgetToken}
            </code>
          </p>
          <button
            onClick={regenerateWidgetToken}
            className="text-[10px] px-2.5 py-1.5 rounded bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
          >
            ↻ Regenerate
          </button>
        </div>
        <div className="flex items-center justify-between p-3 mt-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <div>
            <p className="text-xs text-white/70">Start on login</p>
            <p className="text-[10px] text-white/30 mt-0.5">
              Launch StatusForge automatically when you sign in. Off by default.
            </p>
          </div>
          <Toggle on={autostart} onToggle={toggleAutostart} />
        </div>
      </CollapsibleSection>

      {/* Detection Engine & Pipeline */}
      {config && (() => {
        const isMacOS = platform === "macos";
        return (
        <CollapsibleSection
          title="Detection Engine & Pipeline"
          description="Native Rust detection engine and the ForgeWaterfall process pipeline."
          icon="🔄"
          badge={
            <span className="text-[10px] px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5 border transition-all duration-300 bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              NATIVE
            </span>
          }
        >
          <p className="text-xs text-white/40 mb-4 leading-relaxed">
            Detection runs <strong className="text-emerald-300/80">natively in Rust</strong> on Windows, macOS, and Linux — no Python required.
            {isMacOS && (
              <> On macOS, grant <strong className="text-yellow-300/80">Screen Recording</strong> permission
              (System Settings → Privacy &amp; Security) so the engine can read window titles.</>
            )}
          </p>

          {/* SPARK dual-PC pairing (Hub side) */}
          <div className="mt-2 p-3 bg-blue-500/[0.04] border border-blue-500/15 rounded-xl">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-white/80 font-medium">SPARK Dual-PC Link</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 font-semibold">OPTIONAL</span>
            </div>
            <p className="text-[10px] text-white/30 mb-2">
              Streaming from two PCs? Run the SPARK agent on the gaming PC — this hub receives its
              detections over the LAN and updates overlays exactly like local detection.
            </p>
            <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
              Network PIN
            </label>
            <input
              type="text"
              maxLength={4}
              value={config.engine_settings.spark_pin}
              onChange={(e) =>
                setEngine("spark_pin", e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              placeholder="0000"
              className="input-glass !w-24 tracking-[0.5em] text-center placeholder:tracking-normal font-mono"
            />
            <p className="text-[10px] text-white/25 mt-1.5">
              4-digit PIN — must match the PIN shown in the SPARK agent on your gaming PC.
            </p>
          </div>

          {/* Pipeline section */}
          <div className="mt-6 pt-6 border-t border-white/[0.06]">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/5 flex items-center justify-center text-lg shadow-inner shrink-0">⛓️</span>
              <div>
                <h4 className="text-sm font-semibold text-white/95 tracking-wide">Detection Pipeline</h4>
                <p className="text-[11px] text-white/40 mt-0.5">Configure the 6-stage ForgeWaterfall process pipeline.</p>
              </div>
            </div>

          <p className="text-xs text-white/40 mb-4 leading-relaxed">
            The multi-stage ForgeWaterfall evaluates running processes to decide whether they should
            be accepted, rejected, or forwarded for further analysis.
          </p>

          {/* Pipeline flow indicator */}
          <div className="flex items-center gap-1.5 mb-5 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
            {["1", "2", "3", "4", "5", "6"].map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                <span
                  className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
                    s === "2"
                      ? config.engine_settings.strict_forge_mode
                        ? "bg-green-400 shadow-sm shadow-green-400/50"
                        : "bg-white/15"
                      : s === "3"
                      ? config.engine_settings.process_filter_bypass
                        ? "bg-yellow-400/60 shadow-sm shadow-yellow-400/50"
                        : "bg-green-400"
                      : "bg-green-400"
                  }`}
                />
                {i < 5 && <span className="text-white/[0.08] text-[10px]">→</span>}
              </span>
            ))}
            <span className="text-[11px] font-medium text-white/50 ml-2">
              Waterfall Mode:{" "}
              <span className="text-purple-300">
                {config.engine_settings.strict_forge_mode ? "Strict Lockdown" : "Standard Evaluator"}
              </span>
            </span>
          </div>

          {!showPipelineAdvanced && (
            <button
              type="button"
              onClick={() => setShowPipelineAdvanced(true)}
              className="mt-2 w-full text-left text-[10px] uppercase tracking-wider font-semibold text-white/30 hover:text-white/60 transition-colors cursor-pointer px-3 py-2.5 rounded-lg border border-dashed border-white/[0.06] hover:border-white/[0.12] bg-white/[0.01] hover:bg-white/[0.03]"
            >
              ▸ Advanced
            </button>
          )}

          {showPipelineAdvanced && (
            <button
              type="button"
              onClick={() => setShowPipelineAdvanced(false)}
              className="mb-3 w-full text-left text-[10px] uppercase tracking-wider font-semibold text-white/30 hover:text-white/60 transition-colors cursor-pointer px-3 py-2.5 rounded-lg border border-dashed border-white/[0.06] hover:border-white/[0.12] bg-white/[0.01] hover:bg-white/[0.03]"
            >
              ▸ Simple
            </button>
          )}

          <div className={showPipelineAdvanced ? "flex flex-col gap-1" : "hidden"}>
            {/* Stage 1: Instant Match */}
            <div className="flex items-center justify-between py-3 border-b border-white/[0.05]">
              <div className="flex items-center gap-3.5">
                <span className="w-6 h-6 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                  1
                </span>
                <div>
                  <span className="text-xs text-white/80 font-medium">Instant Match</span>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    Skips immediately to output if process matches a known game in library
                  </p>
                </div>
              </div>
            </div>

            {/* Stage 2: Lockdown */}
            <div className="flex items-center justify-between py-3 border-b border-white/[0.05]">
              <div className="flex items-center gap-3.5">
                <span className="w-6 h-6 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                  2
                </span>
                <div>
                  <span className="text-xs text-white/80 font-medium">Lockdown</span>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    Instantly rejects any process that is not explicitly in your library
                  </p>
                </div>
              </div>
              <Toggle
                on={config.engine_settings.strict_forge_mode}
                onToggle={() =>
                  setEngine("strict_forge_mode", !config.engine_settings.strict_forge_mode)
                }
              />
            </div>

            {/* Stage 3: Behavior Traps */}
            <div className="border-b border-white/[0.05]">
              <div className="flex items-center justify-between py-3">
                <button
                  onClick={() => setTrapsOpen(!trapsOpen)}
                  className="flex items-center gap-3.5 cursor-pointer text-left focus:outline-none"
                >
                  <span className="w-6 h-6 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                    3
                  </span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-white/80 font-medium">Behavior Traps</span>
                      <svg
                        className={`w-3 h-3 text-white/30 transition-transform duration-200 ${
                          trapsOpen ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                    <p className="text-[10px] text-white/30 mt-0.5">
                      Instantly discards non-game software using smart geometric & system traps
                    </p>
                  </div>
                </button>
                <button
                  onClick={() =>
                    setEngine(
                      "process_filter_bypass",
                      !config.engine_settings.process_filter_bypass
                    )
                  }
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-colors cursor-pointer border ${
                    config.engine_settings.process_filter_bypass
                      ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                      : "bg-white/[0.05] text-white/40 border-white/10 hover:bg-white/[0.08]"
                  }`}
                >
                  {config.engine_settings.process_filter_bypass ? "Bypassed" : "Active"}
                </button>
              </div>
              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  trapsOpen ? "max-h-[600px] opacity-100 mb-4" : "max-h-0 opacity-0"
                }`}
              >
                <div className="ml-9 mt-2 p-4 bg-white/[0.02] border border-white/5 rounded-xl flex flex-col gap-4">
                  {/* Emulator Detection */}
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs text-white/70 font-medium">Emulator Detection</span>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        Detect games inside popular emulators (Yuzu, RPCS3, Citra, etc.)
                      </p>
                    </div>
                    <Toggle
                      on={config.engine_settings.emulator_detection}
                      onToggle={() =>
                        setEngine("emulator_detection", !config.engine_settings.emulator_detection)
                      }
                    />
                  </div>
                  {/* RAM Floor */}
                  <div className="border-t border-white/[0.03] pt-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div>
                        <span className="text-xs text-white/70 font-medium">RAM Floor</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Processes consuming less memory are discarded as non-games
                        </p>
                      </div>
                      <span className="text-xs font-mono font-semibold text-purple-300">
                        {config.engine_settings.ram_threshold} MB
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={500}
                      step={10}
                      value={config.engine_settings.ram_threshold}
                      onChange={(e) => setEngine("ram_threshold", parseInt(e.target.value))}
                      className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
                    />
                    <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
                      <span>10 MB</span>
                      <span>500 MB</span>
                    </div>
                  </div>
                  {/* Chromium / Electron Trap */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div>
                      <span className="text-xs text-white/70 font-medium">Chromium / Electron Trap</span>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        Kills Discord, Spotify, VS Code, and other Electron/Chromium shells
                      </p>
                    </div>
                    <Toggle
                      on={config.engine_settings.trap_chromium}
                      onToggle={() =>
                        setEngine("trap_chromium", !config.engine_settings.trap_chromium)
                      }
                    />
                  </div>
                  {/* Command-Line Flag Trap */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div>
                      <span className="text-xs text-white/70 font-medium">Command-Line Flag Trap</span>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        Kills helper processes launched with utility/render flags
                      </p>
                    </div>
                    <Toggle
                      on={config.engine_settings.trap_cmdline}
                      onToggle={() => setEngine("trap_cmdline", !config.engine_settings.trap_cmdline)}
                    />
                  </div>
                  {/* UI Framework Trap */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div>
                      <span className="text-xs text-white/70 font-medium">UI Framework Trap</span>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        Kills known desktop tools like Task Manager, File Explorer, etc.
                      </p>
                    </div>
                    <Toggle
                      on={config.engine_settings.trap_ui_framework}
                      onToggle={() =>
                        setEngine("trap_ui_framework", !config.engine_settings.trap_ui_framework)
                      }
                    />
                  </div>
                  {/* Window Geometry Trap */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div>
                      <span className="text-xs text-white/70 font-medium">Window Geometry Trap</span>
                      <p className="text-[10px] text-white/35 mt-0.5">
                        Kills background or invisible processes with no visible presence
                      </p>
                    </div>
                    <Toggle
                      on={config.engine_settings.trap_geometry}
                      onToggle={() =>
                        setEngine("trap_geometry", !config.engine_settings.trap_geometry)
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Stage 4: Authority Scan */}
            <div className="flex items-center justify-between py-3 border-b border-white/[0.05]">
              <div className="flex items-center gap-3.5">
                <span className="w-6 h-6 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                  4
                </span>
                <div>
                  <span className="text-xs text-white/80 font-medium">Authority Scan</span>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    Overrides criteria if matched in Steam Registry, Discord Rich Presence, or game managers
                  </p>
                </div>
              </div>
            </div>

            {/* Stage 5: Score & Classify */}
            <div className="border-b border-white/[0.05]">
              <div className="flex items-center justify-between py-3">
                <button
                  onClick={() => setScoreOpen(!scoreOpen)}
                  className="flex items-center gap-3.5 cursor-pointer text-left focus:outline-none"
                >
                  <span className="w-6 h-6 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                    5
                  </span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-white/80 font-medium">Score & Classify</span>
                      <svg
                        className={`w-3 h-3 text-white/30 transition-transform duration-200 ${
                          scoreOpen ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                    <p className="text-[10px] text-white/30 mt-0.5">
                      Accumulates weight traits to determine whether a process is a gaming app
                    </p>
                  </div>
                </button>
              </div>
              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  scoreOpen ? "max-h-[600px] opacity-100 mb-4" : "max-h-0 opacity-0"
                }`}
              >
                <div className="ml-9 mt-2 p-4 bg-white/[0.02] border border-white/5 rounded-xl flex flex-col gap-4">
                  {/* Engine DNA */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[10px] font-mono font-bold text-white/35 w-7 text-right">
                        +0.4
                      </span>
                      <div>
                        <span className="text-xs text-white/70 font-medium">Engine DNA</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Check for signatures (Unity, Unreal, Godot, GameMaker, RPG Maker)
                        </p>
                      </div>
                    </div>
                    <Toggle
                      on={config.engine_settings.score_engine_dna}
                      onToggle={() =>
                        setEngine("score_engine_dna", !config.engine_settings.score_engine_dna)
                      }
                    />
                  </div>
                  {/* Fullscreen */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[10px] font-mono font-bold text-white/35 w-7 text-right">
                        +0.3
                      </span>
                      <div>
                        <span className="text-xs text-white/70 font-medium">Fullscreen Presence</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Target owns the active fullscreen foreground graphic viewport
                        </p>
                      </div>
                    </div>
                    <Toggle
                      on={config.engine_settings.score_fullscreen}
                      onToggle={() =>
                        setEngine("score_fullscreen", !config.engine_settings.score_fullscreen)
                      }
                    />
                  </div>
                  {/* Window Title */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[10px] font-mono font-bold text-white/35 w-7 text-right">
                        +0.2
                      </span>
                      <div>
                        <span className="text-xs text-white/70 font-medium">Unique Window Title</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Window title contains localized readable display name (not .exe string)
                        </p>
                      </div>
                    </div>
                    <Toggle
                      on={config.engine_settings.score_window_title}
                      onToggle={() =>
                        setEngine("score_window_title", !config.engine_settings.score_window_title)
                      }
                    />
                  </div>
                  {/* RAM Usage */}
                  <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[10px] font-mono font-bold text-white/35 w-7 text-right">
                        +0.1
                      </span>
                      <div>
                        <span className="text-xs text-white/70 font-medium">Heavy RAM Allocation</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Adds points when memory exceeds the base RAM floor criteria
                        </p>
                      </div>
                    </div>
                    <Toggle
                      on={config.engine_settings.score_ram}
                      onToggle={() => setEngine("score_ram", !config.engine_settings.score_ram)}
                    />
                  </div>

                  {/* Score Threshold */}
                  <div className="border-t border-white/[0.03] pt-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div>
                        <span className="text-xs text-white/70 font-medium">Score Threshold</span>
                        <p className="text-[10px] text-white/35 mt-0.5">
                          Required aggregate weight to classify process as an active game
                        </p>
                      </div>
                      <span className="text-xs font-mono font-semibold text-purple-300">
                        {config.engine_settings.confidence_threshold.toFixed(1)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(config.engine_settings.confidence_threshold * 100)}
                      onChange={(e) =>
                        setEngine("confidence_threshold", parseInt(e.target.value) / 100)
                      }
                      className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
                    />
                    <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
                      <span>0.0 — absolute trust</span>
                      <span>
                        {(
                          (config.engine_settings.score_engine_dna ? 0.4 : 0) +
                          (config.engine_settings.score_fullscreen ? 0.3 : 0) +
                          (config.engine_settings.score_window_title ? 0.2 : 0) +
                          (config.engine_settings.score_ram ? 0.1 : 0)
                        ).toFixed(1)}{" "}
                        — maximum strict
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Stage 6: Forged Output */}
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3.5">
                <span className="w-6 h-6 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                  6
                </span>
                <div>
                  <span className="text-xs text-white/80 font-medium">Forged Output</span>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    Funnels metadata out to your active overlays, rich presence, and chat integrations
                  </p>
                </div>
              </div>
            </div>
          </div>

          </div>
        </CollapsibleSection>
        );
      })()}

      {/* Timing */}
      {config && (
        <CollapsibleSection
          title="Timing & Rates"
          description="Adjust evaluator frequencies and overlay fade thresholds."
          icon="⏳"
          badge={
            <span className="text-[10px] bg-white/5 border border-white/5 text-white/50 px-2 py-0.5 rounded font-mono font-medium">
              Scan: {config.engine_settings.scan_interval}s
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Scan Interval (s)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={config.engine_settings.scan_interval}
                onChange={(e) => setEngine("scan_interval", parseInt(e.target.value) || 1)}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Grace Period (s)
              </label>
              <input
                type="number"
                min={0}
                max={120}
                value={config.engine_settings.grace_period}
                onChange={(e) => setEngine("grace_period", parseInt(e.target.value) || 0)}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Widget Poll Rate (s)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={config.engine_settings.widget_poll_rate}
                onChange={(e) => setEngine("widget_poll_rate", parseInt(e.target.value) || 1)}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Widget Fade Timer (s)
              </label>
              <input
                type="number"
                min={1}
                max={300}
                value={config.engine_settings.widget_fade_timer}
                onChange={(e) => setEngine("widget_fade_timer", parseInt(e.target.value) || 1)}
                className="input-glass font-mono"
              />
            </div>
          </div>

        </CollapsibleSection>
      )}

      {/* Idle State */}
      {config && (
        <CollapsibleSection
          title="Idle State fallback"
          description="Decide fallback behavior when zero active games are found."
          icon="🌙"
          badge={
            <span className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-full font-semibold max-w-[120px] truncate">
              {config.engine_settings.idle_category || "None"}
            </span>
          }
        >
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
              Default Idle Category
            </label>
            <input
              type="text"
              value={config.engine_settings.idle_category}
              onChange={(e) => setEngine("idle_category", e.target.value)}
              placeholder="e.g. Just Chatting"
              className="input-glass"
            />
            <p className="text-[10px] text-white/20 mt-1.5">
              Category published to streaming APIs when no valid game is detected.
            </p>
          </div>

        </CollapsibleSection>
      )}

      {/* Streamer.bot */}
      {config && (
        <CollapsibleSection
          title="Streamer.bot Automation"
          description="Hook events out to local streamer.bot websocket pipelines."
          icon="🤖"
          badge={
            <span className="text-[10px] bg-white/5 border border-white/5 text-white/50 px-2 py-0.5 rounded font-mono font-medium">
              Port: {config.engine_settings.sb_port}
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Port
              </label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={config.engine_settings.sb_port}
                onChange={(e) => setEngine("sb_port", parseInt(e.target.value) || 8080)}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Target Action Name
              </label>
              <input
                type="text"
                value={config.engine_settings.sb_action_name}
                onChange={(e) => setEngine("sb_action_name", e.target.value)}
                placeholder="UpdateCategory"
                className="input-glass"
              />
            </div>
          </div>

        </CollapsibleSection>
      )}

      {/* Token Security */}
      <CollapsibleSection
        title="Token Security"
        description="Migrate tokens from plaintext into the secure operating system keychain."
        icon="🔐"
        badge={
          keychainInfo && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                keychainInfo.count > 0
                  ? "bg-green-500/10 border-green-500/20 text-green-400"
                  : "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"
              }`}
            >
              {keychainInfo.count > 0 ? "Protected" : "Plaintext config"}
            </span>
          )
        }
      >
        <p className="text-xs text-white/50 mb-4 leading-relaxed">
          OAuth keys are normally stored as plain text inside Config.json. Migrating transfers
          credentials into Windows Credential Manager / macOS Keychain, scrubbing them safely from
          disk.
        </p>
        <div className="flex flex-col gap-4">
          <div>
            <button
              onClick={async () => {
                const res = await tauriApi("migrate_tokens_to_keychain");
                if (Array.isArray(res) && res.length) {
                  toast(`Migrated ${res.length} tokens to OS keychain`, "success");
                } else if (Array.isArray(res)) {
                  toast("No tokens to migrate", "info");
                } else {
                  toast("Migration failed", "error");
                }
              }}
              className="btn-cta"
            >
              🔒 Migrate Tokens to Keychain
            </button>
          </div>

          {keychainInfo && keychainInfo.stored.length > 0 && (
            <div className="p-4 bg-white/[0.02] border border-white/5 rounded-xl">
              <span className="text-[10px] uppercase tracking-wider text-white/40 block mb-2 font-bold">
                Stored Keychain Signatures ({keychainInfo.count})
              </span>
              <div className="flex flex-wrap gap-1.5">
                {keychainInfo.stored.map((k) => (
                  <span
                    key={k}
                    className="text-[10px] px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/5 text-white/60 font-mono shadow-sm"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ─── Default config fallback for dev mode (when the Tauri backend is not running) ──
const defaultConfig: AppConfig = {
  api_keys: {
    steamgrid: "7bbccc9fc8a24808bbf291e09680a287",
    rawg: "ca51c9c394c84a9393bbc5e7782b4bd6",
    igdb_client: "",
    igdb_secret: "",
    igdb_token: "tccpdz3xa6w94fvxm89g2c0k4is7qn",
  },
  broadcaster: {
    routing_mode: "native" as const,
    twitch_client: "ixed8yr0njzcpq8daetkmxdzcpktre",
    twitch_secret: "d66u8jfbj6vnj298681basg9c5y180",
    twitch_token: "gd0g2aijmfbmsyqjqioqyc79krskej",
    twitch_refresh: "yrdtvtz5cadppd0auqtxu6tmg4j47xcryk1zs348swbbn4iiay",
    twitch_broadcaster_id: "704830285",
    kick_client: "01KJEPPVHARF4VQBNCC5DC2XGB",
    kick_secret: "31e65c778d76924e869a02ea9fc3526315a304ab2c785086ed5788d8bb356909",
    kick_channel_id: "bearddoddity",
    kick_token: "M2JLNJVINGUTMZC3NS0ZOGFMLWJKMJITNTHMZWRLODU1ZWJI",
    kick_refresh: "ZDZKM2I5NZCTYWU3ZI01OWU3LTGYNZKTOTLIODAWNDYXMZI4",
  },
  engine_settings: {
    idle_category: "Just Chatting",
    sb_port: 8080,
    scan_interval: 15,
    grace_period: 0,
    widget_poll_rate: 8,
    safe_mode: false,
    auto_push: false,
    widget_fade_timer: 15,
    strict_forge_mode: false,
    sb_action_name: "UpdateCategory",
    widget_token: "KXMDVXdcmYRflUGRieg7Sg",
    spark_pin: "0000",
    spark_pairing_key: "",
    emulator_detection: true,
    ram_threshold: 80,
    process_filter_bypass: false,
    confidence_threshold: 0.5,
    trap_chromium: true,
    trap_cmdline: true,
    trap_ui_framework: true,
    trap_geometry: true,
    score_engine_dna: true,
    score_fullscreen: true,
    score_window_title: true,
    score_ram: true,
  },
};

// ─── Key catalog (all available slots) ─────────────────────────────────────
const KEY_CATALOG: {
  key: string;
  label: string;
  desc: string;
  icon: string;
  group?: { key: string; label: string }[];
}[] = [
  { key: "steamgrid", label: "SteamGridDB", desc: "Custom grid artwork, hero banners, and logo images", icon: "🖼️" },
  { key: "rawg", label: "RAWG", desc: "Game metadata — genres, ratings, release dates, screenshots", icon: "🎮" },
  {
    key: "igdb",
    label: "IGDB",
    desc: "Twitch-authenticated IGDB API — game data, covers, screenshots, release dates",
    icon: "🎮",
    group: [
      { key: "igdb_client", label: "Client ID" },
      { key: "igdb_secret", label: "Client Secret" },
      { key: "igdb_token", label: "Access Token" },
    ],
  },
];

// ─── Routing catalog ───────────────────────────────────
const ROUTING_CATALOG: {
  key: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  color: string;
  connectUrl: string;
  userFields: { key: string; label: string }[];
  managedFields?: { key: string; label: string }[];
}[] = [
  {
    key: "twitch",
    label: "Twitch",
    desc: "OAuth2 via Twitch — game category updates, stream info, broadcaster identity",
    icon: (
      <svg width="16" height="16" viewBox="0 0 2400 2800" fill="currentColor">
        <path d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600 V1300z" />
        <rect x="1700" y="550" width="200" height="600" />
        <rect x="1150" y="550" width="200" height="600" />
      </svg>
    ),
    color: "#9146FF",
    connectUrl: "http://127.0.0.1:53735/twitch/login",
    userFields: [
      { key: "twitch_client", label: "Client ID" },
      { key: "twitch_secret", label: "Client Secret" },
    ],
    managedFields: [
      { key: "twitch_token", label: "Access Token" },
      { key: "twitch_refresh", label: "Refresh Token" },
      { key: "twitch_broadcaster_id", label: "Broadcaster ID" },
    ],
  },
  {
    key: "kick",
    label: "Kick",
    desc: "OAuth2 via Kick — channel updates, chat, stream metadata",
    icon: (
      <svg width="16" height="16" viewBox="0 0 453.9 510.6" fill="currentColor">
        <path d="M0,0h170.2v113.5h56.7v-56.7h56.7V0h170.2v170.2h-56.7v56.7h-56.7v56.7h56.7v56.7h56.7v170.2h-170.2v-56.7h-56.7v-56.7h-56.7v113.5H0V0Z" />
      </svg>
    ),
    color: "#00e676",
    connectUrl: "http://127.0.0.1:53735/kick/login",
    userFields: [
      { key: "kick_client", label: "Client ID" },
      { key: "kick_secret", label: "Client Secret" },
      { key: "kick_channel_id", label: "Channel ID" },
    ],
    managedFields: [
      { key: "kick_token", label: "Access Token" },
      { key: "kick_refresh", label: "Refresh Token" },
    ],
  },
];

// ─── API & Routing Sub-tab ──────────────────────────────
function ApiRoutingSubTab({
  toast,
}: {
  toast: (msg: string, type?: ToastType) => void;
}) {
  const [section, setSection] = useState<"keys" | "routing">("keys");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const [floatingClosing, setFloatingClosing] = useState(false);
  const [floatingType, setFloatingType] = useState<"keys" | "routing">("keys");
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [oauthModal, setOauthModal] = useState<{ platform: "twitch" | "kick"; url: string } | null>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const skipSave = useRef(false);

  const loadConfig = useCallback(async () => {
    skipSave.current = true;
    const res = await tauriApi("export_config");
    // A fresh install (no Config.json yet) returns {} — fall back to defaults
    // so section accesses (engine_settings, api_keys, …) never crash.
    if (res && typeof res === "object" && !("error" in res) && "engine_settings" in res) {
      setConfig(res as AppConfig);
    } else {
      setConfig(defaultConfig);
    }
    setTimeout(() => { skipSave.current = false; }, 500);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!config || skipSave.current) return;
    const timer = setTimeout(async () => {
      try {
        const res = await saveConfig(config);
        toast(res, res.includes("success") ? "success" : "error");
      } catch {
        toast("Dev mode: config saved to memory (Tauri not connected)", "info");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && floatingOpen) closeFloating();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [floatingOpen]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data && e.data.type === "oauth-callback") {
        loadConfig();
        if (e.data.status === "success") {
          toast(
            e.data.platform.charAt(0).toUpperCase() + e.data.platform.slice(1) + " connected!",
            "success"
          );
        } else {
          toast(
            e.data.platform.charAt(0).toUpperCase() +
              e.data.platform.slice(1) +
              " connection failed",
            "error"
          );
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadConfig, toast]);

  const openFloating = (type: "keys" | "routing") => {
    setSearch("");
    setFloatingClosing(false);
    setFloatingType(type);
    setFloatingOpen(true);
  };

  const closeFloating = () => {
    setFloatingClosing(true);
    setTimeout(() => {
      setFloatingOpen(false);
      setFloatingClosing(false);
    }, 200);
  };

  // ── API Keys helpers ─────────────────────────────────
  const setKey = (key: string, value: string) => {
    setConfig((prev) => ({
      ...prev!,
      api_keys: { ...prev!.api_keys, [key]: value },
    }));
  };

  const isKeyEntryActive = (entry: (typeof KEY_CATALOG)[number]) => {
    if (entry.group) return entry.group.some((g) => activeApiKeys.includes(g.key as keyof ApiKeys));
    return activeApiKeys.includes(entry.key as keyof ApiKeys);
  };

  const activeApiKeys = config ? (Object.keys(config.api_keys) as Array<keyof ApiKeys>) : [];

  const availableKeys = KEY_CATALOG.filter((k) => !isKeyEntryActive(k));
  const filteredAvailableKeys = search
    ? availableKeys.filter(
        (k) =>
          k.label.toLowerCase().includes(search.toLowerCase()) ||
          k.desc.toLowerCase().includes(search.toLowerCase())
      )
    : availableKeys;

  const addKeyFromCatalog = (entry: (typeof KEY_CATALOG)[number]) => {
    setConfig((prev) => {
      const next = { ...prev!.api_keys };
      if (entry.group) {
        for (const g of entry.group) next[g.key as keyof ApiKeys] = next[g.key as keyof ApiKeys] || "";
        return { ...prev!, api_keys: next };
      }
      next[entry.key as keyof ApiKeys] = "";
      return { ...prev!, api_keys: next };
    });
    setEditingKey(entry.key);
    closeFloating();
  };

  const removeKeyEntry = (entry: (typeof KEY_CATALOG)[number]) => {
    setConfig((prev) => {
      const next = { ...prev!.api_keys };
      if (entry.group) {
        for (const g of entry.group) delete next[g.key as keyof ApiKeys];
      } else {
        delete next[entry.key as keyof ApiKeys];
      }
      return { ...prev!, api_keys: next };
    });
    if (editingKey === entry.key) setEditingKey(null);
    toast("Key removed — save to confirm", "info");
  };

  const truncate = (v: string) =>
    v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : "—";

  // ── Routing helpers ────────────────────────────────
  const setField = (key: string, value: string) => {
    setConfig((prev) => ({
      ...prev!,
      broadcaster: { ...prev!.broadcaster, [key]: value },
    }));
  };

  const isRouteEntryActive = (entry: (typeof ROUTING_CATALOG)[number]) => {
    if (!config) return false;
    const allKeys = [
      ...entry.userFields.map((f) => f.key),
      ...(entry.managedFields?.map((f) => f.key) ?? []),
    ];
    return allKeys.some((k) => !!config.broadcaster[k as keyof typeof config.broadcaster]);
  };

  const availableRoutes = ROUTING_CATALOG.filter((e) => !isRouteEntryActive(e));
  const filteredAvailableRoutes = search
    ? availableRoutes.filter(
        (e) =>
          e.label.toLowerCase().includes(search.toLowerCase()) ||
          e.desc.toLowerCase().includes(search.toLowerCase())
      )
    : availableRoutes;

  const addRouteFromCatalog = (entry: (typeof ROUTING_CATALOG)[number]) => {
    setConfig((prev) => {
      const next = { ...prev!.broadcaster };
      for (const f of entry.userFields) next[f.key as keyof typeof next] = (next[f.key as keyof typeof next] || "") as any;
      return { ...prev!, broadcaster: next };
    });
    setEditingKey(entry.key);
    closeFloating();
  };

  const removeRouteEntry = (entry: (typeof ROUTING_CATALOG)[number]) => {
    setConfig((prev) => {
      const next = { ...prev!.broadcaster };
      const allKeys = [
        ...entry.userFields.map((f) => f.key),
        ...(entry.managedFields?.map((f) => f.key) ?? []),
      ];
      for (const k of allKeys) delete next[k as keyof typeof next];
      return { ...prev!, broadcaster: next };
    });
    if (editingKey === entry.key) setEditingKey(null);
    toast("Integration removed — save to confirm", "info");
  };

  // ── Floating card ─────────────────────────────────
  const renderFloatingCard = () => {
    if (!floatingOpen) return null;
    const isKeys = floatingType === "keys";
    const items = isKeys ? filteredAvailableKeys : filteredAvailableRoutes;
    const title = isKeys ? "Add API Key" : "Add Integration";
    const placeholder = isKeys ? "Search keys…" : "Search integrations…";
    const emptyMain = isKeys ? (search ? "No matches" : "All keys added") : (search ? "No matches" : "All integrations active");
    const emptySub = isKeys ? (search ? "Try a different search term" : "You can manage keys in the list") : (search ? "Try a different search term" : "You can manage integrations in the list");

    return (
      <div
        className={`fixed inset-0 z-[100] flex items-center justify-end bg-black/50 ${
          floatingClosing ? "" : "animate-float-backdrop"
        }`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeFloating();
        }}
      >
        <div
          ref={floatingRef}
          className={`relative w-[380px] h-full max-h-[600px] m-4 flex flex-col bg-black/20 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-purple-900/20 ${
            floatingClosing ? "animate-float-card-out" : "animate-float-card-in"
          }`}
        >
          <div className="p-5 pb-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-sm">{title}</h3>
              <button
                onClick={closeFloating}
                className="w-7 h-7 rounded-lg surface-1 hover:bg-white/[0.1] flex items-center justify-center text-white/40 hover:text-white/80 transition-colors cursor-pointer"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholder}
              className="input-glass"
            />
          </div>

          <div className="flex-1 overflow-y-auto p-5 pt-3 flex flex-col gap-2 min-h-0">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-white/30">
                <p className="text-sm mb-1">{emptyMain}</p>
                <p className="text-[10px]">{emptySub}</p>
              </div>
            ) : isKeys ? (
              (items as (typeof KEY_CATALOG)[number][]).map((k) => (
                <button
                  key={k.key}
                  onClick={() => addKeyFromCatalog(k)}
                  className="flex items-center gap-3 p-3 rounded-xl surface-1 hover:bg-white/[0.07] hover:border-white/15 transition-all cursor-pointer text-left group"
                >
                  <span className="section-head-icon text-sm !w-8 !h-8 !rounded-lg">
                    {k.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-white/80 font-medium block">{k.label}</span>
                    <span className="text-[10px] text-white/30 block truncate">{k.desc}</span>
                  </div>
                  <span className="badge badge-purple opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    + Add
                  </span>
                </button>
              ))
            ) : (
              (items as (typeof ROUTING_CATALOG)[number][]).map((e) => (
                <button
                  key={e.key}
                  onClick={() => addRouteFromCatalog(e)}
                  className="flex items-center gap-3 p-3 rounded-xl surface-1 hover:bg-white/[0.07] hover:border-white/15 transition-all cursor-pointer text-left group"
                >
                  <span
                    className="section-head-icon text-sm !w-8 !h-8 !rounded-lg"
                    style={{ backgroundColor: `${e.color}15`, color: e.color }}
                  >
                    {e.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-white/80 font-medium block">{e.label}</span>
                    <span className="text-[10px] text-white/30 block truncate">{e.desc}</span>
                  </div>
                  <span className="badge badge-purple opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    + Add
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  };

  if (!config) return <p className="text-white/40 p-6">Loading…</p>;

  // ── API Keys display data ──────────────────────────
  const apiKeys = config.api_keys || ({} as AppConfig["api_keys"]);

  const displayKeyEntries = KEY_CATALOG.filter((entry) => isKeyEntryActive(entry));
  const catalogKeys = new Set(
    KEY_CATALOG.flatMap((e) => (e.group ? e.group.map((g) => g.key) : [e.key]))
  );
  const orphanApiKeys = activeApiKeys.filter((k) => !catalogKeys.has(k));
  const orphanKeyEntries: typeof displayKeyEntries = orphanApiKeys.map((k) => ({ key: k, label: k, desc: "", icon: "🔑" }));
  const allKeyDisplay = [...displayKeyEntries, ...orphanKeyEntries];
  const keyCount = allKeyDisplay.length;

  // ── Routing display data ───────────────────────────
  const bc = config.broadcaster || ({} as AppConfig["broadcaster"]);

  const displayRouteEntries = ROUTING_CATALOG.filter((entry) => isRouteEntryActive(entry));
  const routeCatalogKeys = new Set(
    ROUTING_CATALOG.flatMap((e) => [
      ...e.userFields.map((f) => f.key),
      ...(e.managedFields?.map((f) => f.key) ?? []),
    ])
  );
  const activeBroadcasterKeys = Object.keys(bc).filter(
    (k) => !!bc[k as keyof typeof bc] && k !== "routing_mode"
  );
  const orphanRouteKeys = activeBroadcasterKeys.filter((k) => !routeCatalogKeys.has(k));
  const orphanRouteEntries = orphanRouteKeys.map((k) => ({
    key: k,
    label: k,
    desc: "",
    icon: "🔗",
    color: "#fff",
    connectUrl: "",
    userFields: [{ key: k, label: k }],
  })) as typeof displayRouteEntries;
  const allRouteDisplay = [...displayRouteEntries, ...orphanRouteEntries];
  const routeCount = allRouteDisplay.length;

  return (
    <div>
      {renderFloatingCard()}

      {/* Section toggle */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setSection("keys")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 border cursor-pointer ${
            section === "keys"
              ? "bg-purple-500/15 text-purple-300 border-purple-500/25 shadow-md shadow-purple-500/5"
              : "bg-transparent text-white/40 border-transparent hover:text-white/80 hover:bg-white/[0.04]"
          }`}
        >
          <span className="text-sm">🗝️</span>
          API Keys
          {keyCount > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-white/50">{keyCount}</span>}
        </button>
        <button
          onClick={() => setSection("routing")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 border cursor-pointer ${
            section === "routing"
              ? "bg-purple-500/15 text-purple-300 border-purple-500/25 shadow-md shadow-purple-500/5"
              : "bg-transparent text-white/40 border-transparent hover:text-white/80 hover:bg-white/[0.04]"
          }`}
        >
          <span className="text-sm">♾️</span>
          Routing
          {routeCount > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-white/50">{routeCount}</span>}
        </button>
      </div>

      {/* API Keys section */}
      {section === "keys" && (
        <SettingsPanel>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-white font-semibold">API Keys</h3>
            <button
              onClick={() => openFloating("keys")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/25 hover:bg-purple-500/25 hover:border-purple-500/40 transition-all cursor-pointer"
            >
              <span className="text-sm leading-none">+</span>
              Add Key
            </button>
          </div>

          {allKeyDisplay.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-white/30">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-4">
                <svg
                  className="w-6 h-6 text-white/20"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
              </div>
              <p className="text-sm mb-1">No API keys configured</p>
              <p className="text-[10px] text-white/20">Click "Add Key" to get started</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {allKeyDisplay.map((entry) => {
                const isGroup = 'group' in entry && !!(entry as any).group;
                const isEditing = editingKey === entry.key;
                const filledCount = isGroup
                  ? (entry as any).group.filter((g: { key: string }) => !!apiKeys[g.key as keyof ApiKeys]).length
                  : apiKeys[entry.key as keyof ApiKeys]
                  ? 1
                  : 0;
                const totalCount = isGroup ? (entry as any).group.length : 1;
                const hasValue = filledCount > 0;
                const allFilled = filledCount === totalCount;
                const subFilled = isGroup
                  ? `${filledCount}/${totalCount} fields filled`
                  : hasValue
                  ? truncate(apiKeys[entry.key as keyof ApiKeys] as string)
                  : "Not configured";

                return (
                  <div
                    key={entry.key}
                    className={`rounded-xl border transition-all duration-200 ${
                      isEditing
                        ? "bg-white/[0.04] border-purple-500/30"
                        : "bg-white/[0.02] border-white/[0.06] hover:border-white/10"
                    }`}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          hasValue ? (allFilled ? "bg-green-400" : "bg-yellow-400") : "bg-white/15"
                        }`}
                      />
                      <span className="text-lg shrink-0 w-7 h-7 rounded-md bg-white/[0.05] flex items-center justify-center">
                        {entry.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-white/80 font-medium block">{entry.label}</span>
                        <span className="text-[10px] text-white/30 block truncate font-mono">
                          {subFilled}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => setEditingKey(isEditing ? null : entry.key)}
                          className={`btn-icon-sm edit ${isEditing ? "active" : ""}`}
                        >
                          {isEditing ? "Close" : "Edit"}
                        </button>
                        <button
                          onClick={() => removeKeyEntry(entry as (typeof KEY_CATALOG)[number])}
                          className="btn-icon-sm remove"
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    {isEditing && (
                      <div className="px-4 pb-3 pt-0">
                        <div className="ml-9 flex flex-col gap-2.5">
                          {isGroup ? (
                            entry.group!.map((g) => (
                              <div key={g.key}>
                                <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1">
                                  {g.label}
                                </label>
                                <input
                                  type="password"
                                  value={apiKeys[g.key as keyof ApiKeys] || ""}
                                  onChange={(e) => setKey(g.key, e.target.value)}
                                  placeholder={`Enter ${g.label}`}
                                  className="input-glass"
                                />
                              </div>
                            ))
                          ) : (
                            <>
                              <label className="block text-[10px] uppercase tracking-wider text-white/40">
                                {entry.label}
                              </label>
                              <input
                                type="password"
                                value={apiKeys[entry.key as keyof ApiKeys] || ""}
                                onChange={(e) => setKey(entry.key, e.target.value)}
                                placeholder={`Enter ${entry.label}`}
                                className="input-glass"
                                autoFocus
                              />
                              <p className="text-[10px] text-white/20">{entry.desc}</p>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <span className="text-[10px] text-white/25">{keyCount} keys configured</span>
          </div>
        </SettingsPanel>
      )}

      {/* Routing section */}
      {section === "routing" && (
        <SettingsPanel>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-white font-semibold">Broadcaster Routing</h3>
            <button
              onClick={() => openFloating("routing")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/25 hover:bg-purple-500/25 hover:border-purple-500/40 transition-all cursor-pointer"
            >
              <span className="text-sm leading-none">+</span>
              Add Integration
            </button>
          </div>

          {allRouteDisplay.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-white/30">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-4">
                <svg
                  className="w-6 h-6 text-white/20"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                </svg>
              </div>
              <p className="text-sm mb-1">No broadcaster channels routed</p>
              <p className="text-[10px] text-white/20">Click "Add Integration" to connect Twitch or Kick</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {allRouteDisplay.map((entry) => {
                const isEditing = editingKey === entry.key;
                const userFilled = entry.userFields.filter((f) => !!bc[f.key as keyof typeof bc]).length;
                const userTotal = entry.userFields.length;
                const managedFields = 'managedFields' in entry ? (entry as any).managedFields as { key: string; label: string }[] | undefined : undefined;
                const hasOauth = managedFields?.some((f: { key: string }) => !!bc[f.key as keyof typeof bc]) ?? false;
                const hasValue = userFilled > 0 || hasOauth;
                const allFilled = userFilled === userTotal;
                const subFilled = hasOauth
                  ? "Connected via OAuth"
                  : `${userFilled}/${userTotal} configuration fields filled`;

                return (
                  <div
                    key={entry.key}
                    className={`rounded-xl border transition-all duration-200 ${
                      isEditing
                        ? "bg-white/[0.04] border-purple-500/30"
                        : "bg-white/[0.02] border-white/[0.06] hover:border-white/10"
                    }`}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          hasValue ? (allFilled || hasOauth ? "bg-green-400" : "bg-yellow-400") : "bg-white/15"
                        }`}
                      />
                      <span
                        className="text-lg shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
                        style={{ backgroundColor: `${entry.color}15`, color: entry.color }}
                      >
                        {entry.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-white/80 font-medium block font-sans">
                          {entry.label}
                        </span>
                        <span className="text-[10px] text-white/30 block truncate font-mono">
                          {subFilled}
                        </span>
                      </div>

                      <EditRemoveButtons
                        isEditing={isEditing}
                        onToggleEdit={() => setEditingKey(isEditing ? null : entry.key)}
                        onRemove={() => removeRouteEntry(entry as (typeof ROUTING_CATALOG)[number])}
                      />
                    </div>

                    {isEditing && (
                      <div className="px-4 pb-3 pt-0">
                        <div className="ml-9 flex flex-col gap-3">
                          <div className="flex flex-col gap-2.5">
                            {entry.userFields.map((f) => (
                              <div key={f.key}>
                                <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1">
                                  {f.label}
                                </label>
                                <input
                                  type={f.key.includes("secret") ? "password" : "text"}
                                  value={(bc[f.key as keyof typeof bc] as string) || ""}
                                  onChange={(e) => setField(f.key, e.target.value)}
                                  placeholder={`Enter ${f.label}`}
                                  className="input-glass"
                                />
                              </div>
                            ))}
                          </div>

                          {entry.connectUrl && (
                            <button
                              onClick={() => setOauthModal({ platform: entry.key as "twitch" | "kick", url: entry.connectUrl })}
                              className="btn-cta"
                            >
                              🔗 Connect {entry.label}
                            </button>
                          )}

                          {managedFields && managedFields.length > 0 && (
                            <div className="flex flex-col gap-2.5 mt-1 pt-2.5 border-t border-white/[0.06]">
                              <span className="text-[10px] uppercase tracking-wider text-white/25 font-semibold">
                                Managed (from OAuth)
                              </span>
                              {managedFields.map((f: { key: string; label: string }) => {
                                const val = bc[f.key as keyof typeof bc] as string;
                                return (
                                  <div key={f.key} className="flex items-center justify-between">
                                    <div className="flex-1 min-w-0">
                                      <span className="text-[10px] text-white/40 block">{f.label}</span>
                                      <span className="text-[10px] text-white/20 font-mono block truncate">
                                        {val
                                          ? val.length > 12
                                            ? val.slice(0, 6) + "…" + val.slice(-4)
                                            : val
                                          : "—"}
                                      </span>
                                    </div>
                                    <span
                                      className={`text-[9px] px-1.5 py-0.5 rounded ${
                                        val
                                          ? "bg-green-500/10 text-green-400/70"
                                          : "bg-white/[0.04] text-white/20"
                                      }`}
                                    >
                                      {val ? "Active" : "Pending"}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <span className="text-[10px] text-white/25">{routeCount} integrations configured</span>
          </div>
        </SettingsPanel>
      )}

      {oauthModal && (
        <OAuthConnectModal
          open={!!oauthModal}
          onClose={() => setOauthModal(null)}
          platform={oauthModal.platform}
          connectUrl={oauthModal.url}
          onSuccess={() => {
            loadConfig();
            setOauthModal(null);
            toast(oauthModal.platform.charAt(0).toUpperCase() + oauthModal.platform.slice(1) + " connected!", "success");
          }}
        />
      )}
    </div>
  );
}

// ─── About Sub-tab ───────────────────────────────────────────────────────────
function AboutSubTab({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  return (
    <div>
      <CollapsibleSection
        title="System Information Dashboard"
        description="View hardware variables, Tauri dependencies, and database signatures."
        icon="ℹ️"
        defaultOpen={true}
        badge={
          <span className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-full font-semibold">
            StatusForge v1.0.8
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: "App Version", value: "0.5.0", icon: "🚀" },
            { label: "Tauri Version", value: "2.x Native", icon: "🦀" },
            { label: "Runtime Host", value: navigator.platform, icon: "💻" },
            { label: "Local Database", value: "Forge_Database.json", icon: "📂" },
            { label: "Keychain Service", value: "Active (Encrypted)", icon: "🛡️" },
            { label: "Environment Mode", value: "Tauri native host", icon: "🌐" },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between bg-white/[0.02] border border-white/5 rounded-xl px-4 py-3 shadow-inner"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-sm shrink-0">{item.icon}</span>
                <span className="text-[11px] text-white/40 uppercase tracking-wider font-semibold truncate">
                  {item.label}
                </span>
              </div>
              <span className="text-xs font-mono font-bold text-white/70 truncate ml-2">
                {item.value}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-6 pt-4 border-t border-white/[0.04] flex gap-2">
          <button
            onClick={() => toast("System parameters synchronized", "success")}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] border border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90 transition-all cursor-pointer"
          >
            Refresh Info
          </button>
          <button
            onClick={() => toast("JSON configuration exported", "success")}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] border border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90 transition-all cursor-pointer"
          >
            Export Config
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ─── System Sub-tab ───────────────────────────────────────────────────────────
// SystemPrefs interface/defaults/apply live in src/systemPrefs.ts (shared with
// App.tsx boot wiring and useWebSocket).

function AdvancedAnimations({
  prefs,
  set,
}: {
  prefs: ThemePrefs;
  set: (key: keyof ThemePrefs, value: string | boolean) => void;
}) {
  return (
    <>
      <div className="border-t border-white/[0.03] pt-4">
        <label className="block text-xs text-white/70 font-semibold mb-2 uppercase tracking-wider text-[9px]">
          Global Transition Speed
        </label>
        <div className="grid grid-cols-4 gap-2">
          {(["instant", "fast", "normal", "slow"] as const).map((speed) => (
            <button
              key={speed}
              onClick={() => set("transitionSpeed", speed)}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer border ${
                prefs.transitionSpeed === speed
                  ? "bg-purple-500/15 text-purple-300 border-purple-500/25 shadow"
                  : "bg-white/[0.03] text-white/40 border-white/[0.06] hover:bg-white/[0.06]"
              }`}
            >
              {speed.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Cover art effects */}
      <div className="border-t border-white/[0.03] pt-4">
        <span className="block text-white/40 text-[9px] uppercase tracking-wider font-semibold mb-3">
          Cover Artwork Effects
        </span>
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Cover Breathing Scaling</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Slow pulsing zoom on &quot;Now Playing&quot; cover arts
              </p>
            </div>
            <Toggle
              on={prefs.coverBreathe}
              onToggle={() => set("coverBreathe", !prefs.coverBreathe)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Cover Glint Reflection</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Sweeping bright diagonal reflection across art pieces
              </p>
            </div>
            <Toggle on={prefs.coverGlint} onToggle={() => set("coverGlint", !prefs.coverGlint)} />
          </div>
        </div>
      </div>

      {/* Library Cards */}
      <div className="border-t border-white/[0.03] pt-4">
        <span className="block text-white/40 text-[9px] uppercase tracking-wider font-semibold mb-3">
          Library Card Elements
        </span>
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Hover Card Lifting</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Translate library elements vertically and drop nice shadows on hover
              </p>
            </div>
            <Toggle
              on={prefs.cardHoverLift}
              onToggle={() => set("cardHoverLift", !prefs.cardHoverLift)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Card Sweep Glint</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Run soft light sweeps across card bounds on cursor hover
              </p>
            </div>
            <Toggle on={prefs.cardGlint} onToggle={() => set("cardGlint", !prefs.cardGlint)} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Holographic Borders</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Animate rainbow accent borders on cursor hover
              </p>
            </div>
            <Toggle on={prefs.holoEffects} onToggle={() => set("holoEffects", !prefs.holoEffects)} />
          </div>
        </div>
      </div>

      {/* Core UI feedback */}
      <div className="border-t border-white/[0.03] pt-4">
        <span className="block text-white/40 text-[9px] uppercase tracking-wider font-semibold mb-3">
          Dashboard Elements
        </span>
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">Indicators Pulsing</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Pulsing green/yellow nodes for LIVE &amp; active system engines
              </p>
            </div>
            <Toggle on={prefs.statusPulse} onToggle={() => set("statusPulse", !prefs.statusPulse)} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Toast Notification slide</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Smooth slide-in coordinates for notifications
              </p>
            </div>
            <Toggle
              on={prefs.toastAnimations}
              onToggle={() => set("toastAnimations", !prefs.toastAnimations)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Overlay Popups slide</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Smooth scaling and fade curves for modal cards
              </p>
            </div>
            <Toggle
              on={prefs.modalAnimations}
              onToggle={() => set("modalAnimations", !prefs.modalAnimations)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">Usage Bar Transition</span>
              <p className="text-[10px] text-white/35 mt-0.5 font-sans">
                Enable smooth layout width transitions on CPU / Memory monitoring stats
              </p>
            </div>
            <Toggle
              on={prefs.progressBarAnimation}
              onToggle={() => set("progressBarAnimation", !prefs.progressBarAnimation)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.02] pt-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Button Hover Lift</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Subtle shadow scale changes when hovering cursor over button elements
              </p>
            </div>
            <Toggle
              on={prefs.buttonHoverEffects}
              onToggle={() => set("buttonHoverEffects", !prefs.buttonHoverEffects)}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function SystemSubTab({ toast, config, setConfig, onSaveConfig }: { toast: (msg: string, type?: ToastType) => void; config: AppConfig | null; setConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>; onSaveConfig: (section: string) => Promise<void> }) {
  const [prefs, setPrefs] = useState<SystemPrefs>(loadSystemPrefs);
  const [showAnimAdvanced, setShowAnimAdvanced] = useState(false);
  const skipSave = useRef(false);

  const toggle = (key: keyof SystemPrefs) => {
    setPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const set = (key: keyof SystemPrefs, value: string | boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  // "Launch on Login" is backed by the OS autostart entry, not localStorage —
  // read the real state on mount and write it via set_autostart on toggle.
  useEffect(() => {
    tauriApi("get_autostart")
      .then((v) => {
        if (typeof v === "boolean") setPrefs((p) => ({ ...p, launchOnLogin: v }));
      })
      .catch(() => {});
  }, []);

  const toggleLaunchOnLogin = async () => {
    const next = !prefs.launchOnLogin;
    const res = await tauriApi("set_autostart", { enabled: next });
    if (res && typeof res === "object" && "error" in res) {
      toast(`Autostart failed: ${(res as { error: string }).error}`, "error");
      return;
    }
    set("launchOnLogin", next);
    toast(next ? "StatusForge will start on login" : "Autostart disabled", "success");
  };

  useEffect(() => {
    if (skipSave.current) return;
    const timer = setTimeout(() => {
      // Persists + applies (hardware-accel class); log level goes to the
      // Rust logger immediately.
      saveSystemPrefs(prefs);
      tauriApi("set_log_level", { level: prefs.logLevel });
    }, 300);
    return () => clearTimeout(timer);
  }, [prefs]);

  const exportConfig = async () => {
    try {
      const res = await tauriApi("export_config");
      if (res && typeof res === "object") {
        const blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `statusforge_config_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast("Config exported", "success");
      }
    } catch {
      toast("Export failed — Tauri not connected", "error");
    }
  };

  const startupCount = [prefs.launchOnLogin, prefs.autoStartEngine, prefs.minimizeToTray].filter(
    Boolean
  ).length;
  const notifyCount = [
    prefs.showNotifications,
    prefs.notifyOnGameDetect,
    prefs.notifyOnStreamEvents,
  ].filter(Boolean).length;
  const integrationsCount = [prefs.customWebhookEnabled].filter(Boolean).length;

  return (
    <div>
      {/* Startup */}
      <CollapsibleSection
        title="Startup & OS"
        description="Configure how StatusForge initializes and behaves on computer boot."
        icon="🚀"
        badge={
          <span className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-full font-semibold">
            {startupCount} / 3 Enabled
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Launch on Login</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Automatically run StatusForge on user log-in
              </p>
            </div>
            <Toggle on={prefs.launchOnLogin} onToggle={toggleLaunchOnLogin} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Auto-start Engine</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Immediately start the native detection engine when the UI app starts
              </p>
            </div>
            <Toggle on={prefs.autoStartEngine} onToggle={() => toggle("autoStartEngine")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Minimize to Tray</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Closing the primary window hides StatusForge inside the OS menu bar/tray
              </p>
            </div>
            <Toggle on={prefs.minimizeToTray} onToggle={() => toggle("minimizeToTray")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Display */}
      <CollapsibleSection
        title="Display & Hardware"
        description="Leverage your GPU for hardware-accelerated animations and layouts."
        icon="📺"
        badge={
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              prefs.hardwareAccel
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-white/5 border-white/5 text-white/40"
            }`}
          >
            {prefs.hardwareAccel ? "GPU Enabled" : "CPU Bound"}
          </span>
        }
      >
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-white/75 font-medium">Hardware Acceleration</span>
            <p className="text-[10px] text-white/35 mt-0.5">
              Leverage graphics core resources for composite window rendering (reduces lag)
            </p>
          </div>
          <Toggle on={prefs.hardwareAccel} onToggle={() => toggle("hardwareAccel")} />
        </div>
      </CollapsibleSection>

      {/* Notifications */}
      <CollapsibleSection
        title="Alert Notifications"
        description="Receive rich desktop alerts and toaster notifications on crucial app events."
        icon="🔔"
        badge={
          <span className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-full font-semibold">
            {notifyCount} / 3 Active
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Master Notifications</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Enable global operating system alerts for StatusForge events
              </p>
            </div>
            <Toggle on={prefs.showNotifications} onToggle={() => toggle("showNotifications")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Game Detection Alerts</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Deliver alerts immediately when a new active process is successfully verified
              </p>
            </div>
            <Toggle on={prefs.notifyOnGameDetect} onToggle={() => toggle("notifyOnGameDetect")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Category Broadcast Events</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Notify when Twitch / Kick channel categories update successfully
              </p>
            </div>
            <Toggle on={prefs.notifyOnStreamEvents} onToggle={() => toggle("notifyOnStreamEvents")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Integrations */}
      <CollapsibleSection
        title="Integrations"
        description="Publish live status events to a custom webhook."
        icon="🎮"
        badge={
          <span className="text-[10px] bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-full font-semibold">
            {integrationsCount} / 1 Hooked
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Custom Webhook Relay</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Send real-time JSON payload events directly to an HTTP destination
              </p>
            </div>
            <Toggle
              on={prefs.customWebhookEnabled}
              onToggle={() => toggle("customWebhookEnabled")}
            />
          </div>
          {prefs.customWebhookEnabled && (
            <div className="mt-1 ml-1 pl-4 border-l border-white/5">
              <input
                type="url"
                value={prefs.customWebhookUrl}
                onChange={(e) => set("customWebhookUrl", e.target.value)}
                placeholder="https://your-server.com/webhook"
                className="input-glass font-mono"
              />
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Network */}
      <CollapsibleSection
        title="Network socket configuration"
        description="Establish fail-safes for websocket connection dropouts."
        icon="🌐"
        badge={
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              prefs.wsAutoReconnect
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-white/5 border-white/5 text-white/40"
            }`}
          >
            {prefs.wsAutoReconnect ? "Auto-Recovery" : "Manual Reconnect"}
          </span>
        }
      >
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-white/75 font-medium font-sans">
              Auto-Reconnect WebSocket
            </span>
            <p className="text-[10px] text-white/35 mt-0.5">
              Instantly retry socket handshakes if the link with the engine falls out
            </p>
          </div>
          <Toggle on={prefs.wsAutoReconnect} onToggle={() => toggle("wsAutoReconnect")} />
        </div>
      </CollapsibleSection>

      {/* Logging & Data */}
      <CollapsibleSection
        title="Console, Logs & Versioning"
        description="Manage log verbosities, backups, and app updates."
        icon="📓"
        badge={
          <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-medium uppercase border ${
            prefs.updateChannel === "closed-beta"
              ? "bg-red-500/10 border-red-500/20 text-red-400"
              : prefs.updateChannel === "beta"
              ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"
              : "bg-white/5 border-white/5 text-white/50"
          }`}>
            Channel: {prefs.updateChannel === "closed-beta" ? "Closed Beta" : prefs.updateChannel}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">Debug Log Level</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Set granularity of runtime stdout logging
              </p>
            </div>
            <GlassSelect
              value={prefs.logLevel}
              options={[
                { value: "error", label: "Error" },
                { value: "warn", label: "Warning" },
                { value: "info", label: "Info" },
                { value: "debug", label: "Debug" },
              ]}
              onChange={(v) => set("logLevel", v as any)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Dashboard Language</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Set default localization for dashboard displays
              </p>
            </div>
            <GlassSelect
              value={prefs.language}
              options={[{ value: "en", label: "English (US)" }]}
              onChange={(v) => set("language", v)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Release Track Channel</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Opt-in for experimental developer versions or production builds
              </p>
            </div>
            <GlassSelect
              value={prefs.updateChannel}
              options={[
                { value: "stable", label: "Stable" },
                { value: "beta", label: "Beta (Nightly)" },
                { value: "closed-beta", label: "Closed Beta (Dev)" },
              ]}
              onChange={(v) => set("updateChannel", v as any)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Automatic Backups</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Keep a Config.json.bak copy of the prior config before writing updates
              </p>
            </div>
            <Toggle on={prefs.configBackupEnabled} onToggle={() => toggle("configBackupEnabled")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Actions */}
      <div className="flex gap-3 mt-5">
        <button onClick={exportConfig} className="btn-ghost">Export Config</button>
      </div>
    </div>
  );
}

// ─── Theme prefs ──────────────────────────────────────────────────────────────
// Storage + CSS application live in src/theme.ts (shared with App.tsx so the
// full theme applies on boot, not just after visiting this tab).

const ACCENT_PRESETS: { name: string; color: string; bg: string }[] = [
  { name: "Twitch Purple", color: "#9146FF", bg: "#080212" },
  { name: "Kick Green", color: "#00e676", bg: "#021208" },
  { name: "Electric Blue", color: "#3b82f6", bg: "#030818" },
  { name: "Crimson", color: "#ef4444", bg: "#120303" },
  { name: "Amber", color: "#f59e0b", bg: "#120e02" },
  { name: "Cyan", color: "#06b6d4", bg: "#021014" },
  { name: "Pink", color: "#ec4899", bg: "#12030c" },
  { name: "Silver", color: "#94a3b8", bg: "#0a0c10" },
];

const BG_PRESETS: { name: string; color: string }[] = [
  { name: "Forge Black", color: "#050505" },
  { name: "Charcoal", color: "#0c0c0e" },
  { name: "Obsidian", color: "#0a0a12" },
  { name: "Midnight", color: "#02040a" },
  { name: "Warm Dark", color: "#0a0806" },
  { name: "Slate", color: "#0d1117" },
];


// ─── Image Compression Helper ────────────────────────────────────────────────
// Compresses uploaded images to JPEG at 85% quality, max 1920px, to keep
// data URLs small enough for localStorage (~5MB quota).
function compressImage(file: File, maxSize = 1920, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    // Reject files larger than 25MB (before compression)
    if (file.size > 25 * 1024 * 1024) {
      reject(new Error("Image too large. Max 25 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
          else { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas not supported")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// ─── Theme Sub-tab ────────────────────────────────────────────────────────────
function ThemeSubTab({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  const [prefs, setPrefs] = useState<ThemePrefs>(loadThemePrefs);
  const [showAnimAdvanced, setShowAnimAdvanced] = useState(false);
  const skipSave = useRef(false);

  const set = <K extends keyof ThemePrefs>(key: K, value: ThemePrefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (skipSave.current) return;
    const timer = setTimeout(() => {
      try {
        saveThemePrefs(prefs);
        applyThemePrefs(prefs);
      } catch {
        if (prefs.bgImage.startsWith("data:") && prefs.bgImage.length > 4 * 1024 * 1024) {
          toast("Background image too large for storage. Try a smaller image.", "error");
        }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [prefs]);

  const radiusLabel = (r: ThemePrefs["borderRadius"]) =>
    r === "sharp" ? "Sharp (2px)" : r === "soft" ? "Soft (8px)" : "Rounded (16px)";
  const densityLabel = (d: ThemePrefs["density"]) =>
    d === "compact" ? "Compact" : d === "spacious" ? "Spacious" : "Default";

  return (
    <div>
      {/* Live Theme Preview — top of tab */}
      <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5 mb-5 relative overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-white font-semibold text-xs uppercase tracking-wider">
            Live Theme Preview
          </h4>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: prefs.accentColor }} />
            <span className="text-[10px] font-mono text-white/30">{prefs.accentColor.toUpperCase()}</span>
            <span className="text-white/10">•</span>
            <span className="w-2.5 h-2.5 rounded-full border border-white/10" style={{ backgroundColor: prefs.bgColor }} />
            <span className="text-[10px] font-mono text-white/30">{prefs.bgColor.toUpperCase()}</span>
          </div>
        </div>
        <div
          className="relative rounded-xl p-5 border border-white/10 overflow-hidden shadow-2xl"
          style={{ backgroundColor: prefs.bgColor }}
        >
          {prefs.bgImage && (
            <div
              className="absolute inset-0 z-0"
              style={{
                backgroundImage: `url(${prefs.bgImage})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                opacity: prefs.bgOpacity / 100,
                filter: `blur(${prefs.bgBlur}px)`,
              }}
            />
          )}
          <div className="relative z-10">
            <div
              className="p-4 mb-3 border border-white/10"
              style={{
                backgroundColor: `rgba(255,255,255,${(prefs.panelOpacity / 100) * 0.06})`,
                borderRadius:
                  prefs.borderRadius === "sharp"
                    ? "2px"
                    : prefs.borderRadius === "soft"
                    ? "8px"
                    : "16px",
              }}
            >
              <p className="text-xs font-bold mb-1" style={{ color: prefs.accentColor }}>
                Sample Card Container
              </p>
              <p className="text-[10px] text-white/50 mb-3 leading-relaxed">
                See your theme changes update in real-time as you adjust settings below.
              </p>
              <div className="flex gap-2">
                <span
                  className="px-3 py-1.5 text-[10px] font-bold shadow-sm"
                  style={{
                    backgroundColor: `${prefs.accentColor}22`,
                    color: prefs.accentColor,
                    border: `1px solid ${prefs.accentColor}44`,
                    borderRadius:
                      prefs.borderRadius === "sharp"
                        ? "2px"
                        : prefs.borderRadius === "soft"
                        ? "6px"
                        : "12px",
                  }}
                >
                  Primary Button
                </span>
                <span
                  className="px-3 py-1.5 text-[10px] font-medium text-white/60 bg-white/[0.04] border border-white/10"
                  style={{
                    borderRadius:
                      prefs.borderRadius === "sharp"
                        ? "2px"
                        : prefs.borderRadius === "soft"
                        ? "6px"
                        : "12px",
                  }}
                >
                  Ghost Button
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: prefs.accentColor }} />
              <span className="text-[10px] text-white/40 font-medium">Streamer status active</span>
              <span className="text-[10px] text-white/20 font-mono ml-auto">Token: KXMDV•••Sg</span>
            </div>
          </div>
        </div>
      </div>

      {/* Colors */}
      <CollapsibleSection
        title="App Colors & Presets"
        description="Choose primary accents and overall dark theme base background colors."
        icon="🎨"
        badge={
          <div className="flex items-center gap-1.5 bg-white/5 px-2 py-0.5 rounded border border-white/5 font-mono text-[10px]">
            <span
              className="w-2 h-2 rounded-full shadow"
              style={{ backgroundColor: prefs.accentColor }}
            />
            {prefs.accentColor.toUpperCase()}
          </div>
        }
      >
        {/* Accent Color */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Accent Color</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Primary highlights, toggles, borders, and main interactable buttons
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-all shrink-0 shadow-sm p-0.5" style={{ backgroundColor: prefs.accentColor }}>
                <input
                  type="color"
                  value={prefs.accentColor}
                  onChange={(e) => set("accentColor", e.target.value)}
                  className="w-full h-full cursor-pointer opacity-0"
                />
              </div>
              <input
                type="text"
                value={prefs.accentColor}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) set("accentColor", v);
                }}
                className="input-glass !w-24 !py-1.5 !px-2.5 text-[11px] font-mono text-center uppercase"
                maxLength={7}
                placeholder="#9146FF"
              />
            </div>
          </div>
          {/* Accent Presets */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 pt-2">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.color}
                onClick={() => {
                  set("accentColor", p.color);
                  set("bgColor", p.bg);
                }}
                className={`relative flex flex-col items-center gap-2 p-3 rounded-xl text-[10px] font-semibold transition-all cursor-pointer border shrink-0 w-[72px] group ${
                  prefs.accentColor === p.color
                    ? "border-white/25 bg-white/[0.08] text-white/90 shadow-lg shadow-black/20"
                    : "border-white/[0.05] bg-white/[0.02] text-white/40 hover:bg-white/[0.06] hover:text-white/70 hover:border-white/10"
                }`}
              >
                <div
                  className="w-8 h-8 rounded-lg shadow-sm transition-transform group-hover:scale-110"
                  style={{ backgroundColor: p.color }}
                />
                <span className="truncate w-full text-center leading-tight">{p.name}</span>
                {prefs.accentColor === p.color && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white text-black text-[8px] font-bold flex items-center justify-center shadow-md">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Base Background Color */}
        <div className="border-t border-white/[0.03] pt-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="text-xs text-white/75 font-medium">Base Background Color</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Primary underlying background fill for the viewport
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-all shrink-0 shadow-sm p-0.5" style={{ backgroundColor: prefs.bgColor }}>
                <input
                  type="color"
                  value={prefs.bgColor}
                  onChange={(e) => set("bgColor", e.target.value)}
                  className="w-full h-full cursor-pointer opacity-0"
                />
              </div>
              <input
                type="text"
                value={prefs.bgColor}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) set("bgColor", v);
                }}
                className="input-glass !w-24 !py-1.5 !px-2.5 text-[11px] font-mono text-center uppercase"
                maxLength={7}
                placeholder="#050505"
              />
            </div>
          </div>
          {/* Background Presets */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 pt-2">
            {BG_PRESETS.map((p) => (
              <button
                key={p.color}
                onClick={() => set("bgColor", p.color)}
                className={`relative flex flex-col items-center gap-2 p-3 rounded-xl text-[10px] font-semibold transition-all cursor-pointer border shrink-0 w-[72px] group ${
                  prefs.bgColor === p.color
                    ? "border-white/25 bg-white/[0.08] text-white/90 shadow-lg shadow-black/20"
                    : "border-white/[0.05] bg-white/[0.02] text-white/40 hover:bg-white/[0.06] hover:text-white/70 hover:border-white/10"
                }`}
              >
                <div
                  className="w-8 h-8 rounded-lg shadow-sm border border-white/[0.08] transition-transform group-hover:scale-110"
                  style={{ backgroundColor: p.color }}
                />
                <span className="truncate w-full text-center leading-tight">{p.name}</span>
                {prefs.bgColor === p.color && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white text-black text-[8px] font-bold flex items-center justify-center shadow-md">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </CollapsibleSection>

      {/* Background Image / Blur */}
      <CollapsibleSection
        title="Background Wallpaper"
        description="Configure backdrop transparency layers, custom image uploads, and blur."
        icon="🖼️"
        badge={
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              prefs.bgImage
                ? "bg-purple-500/10 border-purple-500/20 text-purple-300"
                : "bg-white/5 border-white/5 text-white/40"
            }`}
          >
            {prefs.bgImage ? "Active" : "None"}
          </span>
        }
      >
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-xs text-white/75 font-medium">Upload custom wallpaper</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Set an image backdrop behind the dashboard layouts
              </p>
            </div>
            {prefs.bgImage && (
              <button
                onClick={() => set("bgImage", "")}
                className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 hover:text-red-400 transition-colors cursor-pointer"
              >
                Remove
              </button>
            )}
          </div>

          {prefs.bgImage ? (
            <div className="relative w-full h-32 rounded-xl overflow-hidden border border-white/10 group">
              <img src={prefs.bgImage} alt="Background preview" className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <label className="px-3.5 py-1.5 rounded-xl bg-white/10 border border-white/20 text-white/90 text-xs font-semibold cursor-pointer hover:bg-white/20 transition-all">
                  Upload New
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      set("bgImage", "");
                      compressImage(file)
                        .then((compressed) => {
                          try {
                            set("bgImage", compressed);
                          } catch {
                            toast("Failed to save background — image may be too large", "error");
                          }
                        })
                        .catch((err) => {
                          toast(err.message || "Failed to process image", "error");
                        });
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center w-full h-32 rounded-xl border border-dashed border-white/15 cursor-pointer hover:border-white/25 hover:bg-white/[0.02] transition-all">
              <svg
                className="w-6 h-6 text-white/20 mb-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <span className="text-xs text-white/40 font-medium">Click to upload wallpaper</span>
              <span className="text-[10px] text-white/20 mt-0.5">PNG, JPG, WEBP</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  set("bgImage", "");
                  compressImage(file)
                    .then((compressed) => {
                      try {
                        set("bgImage", compressed);
                      } catch {
                        toast("Failed to save background — image may be too large", "error");
                      }
                    })
                    .catch((err) => {
                      toast(err.message || "Failed to process image", "error");
                    });
                  e.target.value = "";
                }}
              />
            </label>
          )}
          <div className="mt-3">
            <input
              type="url"
              value={prefs.bgImage.startsWith("data:") ? "" : prefs.bgImage}
              onChange={(e) => set("bgImage", e.target.value)}
              placeholder="Or paste an image URL destination…"
              className="input-glass font-mono"
            />
          </div>
        </div>

        {/* Background Opacity */}
        <div className="mb-5 border-t border-white/[0.03] pt-4">
          <div className="flex items-center justify-between mb-1.5">
            <div>
              <span className="text-xs text-white/75 font-medium">Backdrop Overlay Opacity</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Set image visibility overlay transparency scales
              </p>
            </div>
            <span className="text-xs font-mono font-semibold text-purple-300">
              {prefs.bgOpacity}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={prefs.bgOpacity}
            onChange={(e) => set("bgOpacity", parseInt(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
            <span>0% — transparent</span>
            <span>100% — solid</span>
          </div>
        </div>

        {/* Background Blur */}
        <div className="border-t border-white/[0.03] pt-4">
          <div className="flex items-center justify-between mb-1.5">
            <div>
              <span className="text-xs text-white/75 font-medium">Backdrop Gaussian Blur</span>
              <p className="text-[10px] text-white/35 mt-0.5 font-sans">
                Apply standard hardware-accelerated blurring to background pixels
              </p>
            </div>
            <span className="text-xs font-mono font-semibold text-purple-300">{prefs.bgBlur}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={prefs.bgBlur}
            onChange={(e) => set("bgBlur", parseInt(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
            <span>0px — ultra sharp</span>
            <span>40px — heavy frost</span>
          </div>
        </div>
      </CollapsibleSection>

      {/* Panels & Radius */}
      <CollapsibleSection
        title="Panels & Geometry"
        description="Configure rounding factors, font scales, and container panel transparency."
        icon="📐"
        badge={
          <span className="text-[10px] bg-white/5 border border-white/5 text-white/50 px-2 py-0.5 rounded font-mono font-medium">
            Radius: {prefs.borderRadius}
          </span>
        }
      >
        <div className="mb-5">
          <div className="flex items-center justify-between mb-1.5">
            <div>
              <span className="text-xs text-white/75 font-medium">Glass Panel Opacity</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Backdrop opacity scale for main panel cards
              </p>
            </div>
            <span className="text-xs font-mono font-semibold text-purple-300">
              {prefs.panelOpacity}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={prefs.panelOpacity}
            onChange={(e) => set("panelOpacity", parseInt(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
            <span>0% — hollow</span>
            <span>100% — solid dark</span>
          </div>
        </div>

        {/* Border Radius */}
        <div className="flex items-center justify-between border-t border-white/[0.03] pt-4 mb-5">
          <div>
            <span className="text-xs text-white/75 font-medium">Border Radius</span>
            <p className="text-[10px] text-white/35 mt-0.5">
              Roundness parameters of container cards and action buttons
            </p>
          </div>
          <GlassSelect
            value={prefs.borderRadius}
            options={[
              { value: "sharp", label: radiusLabel("sharp") },
              { value: "soft", label: radiusLabel("soft") },
              { value: "rounded", label: radiusLabel("rounded") },
            ]}
            onChange={(v) => set("borderRadius", v as any)}
          />
        </div>

        {/* Font Scale */}
        <div className="border-t border-white/[0.03] pt-4">
          <div className="flex items-center justify-between mb-1.5">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">Global Font Scale</span>
              <p className="text-[10px] text-white/35 mt-0.5">Scale size metrics of core texts</p>
            </div>
            <span className="text-xs font-mono font-semibold text-purple-300">
              {prefs.fontScale}%
            </span>
          </div>
          <input
            type="range"
            min={75}
            max={125}
            step={5}
            value={prefs.fontScale}
            onChange={(e) => set("fontScale", parseInt(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[9px] text-white/20 mt-0.5 font-mono">
            <span>75% — compact</span>
            <span>125% — generous</span>
          </div>
          <div className="mt-3 bg-white/[0.02] border border-white/5 rounded-xl px-4 py-2.5">
            <p style={{ fontSize: `${prefs.fontScale}%` }} className="text-white/60 truncate font-sans">
              Preview: StatusForge game evaluation engines are ready.
            </p>
          </div>
        </div>
      </CollapsibleSection>

      {/* Animations & Visual Effects */}
      <CollapsibleSection
        title="Micro-Animations & FX"
        description="Toggle holographic borders, breathing covers, status sweeps, and progress bars."
        icon="✨"
        badge={
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              prefs.animationsEnabled
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-white/5 border-white/5 text-white/40"
            }`}
          >
            {prefs.animationsEnabled ? "Motion Active" : "Static UI"}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Quality</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Enable transitions and rich dynamic layout movements
              </p>
            </div>
            <Toggle
              on={prefs.animationsEnabled}
              onToggle={() => set("animationsEnabled", !prefs.animationsEnabled)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Performance</span>
              <p className="text-[10px] text-white/35 mt-0.5 font-sans">
                Instantly terminate all hover translations and scales for optimal hardware response
              </p>
            </div>
            <Toggle on={prefs.reducedMotion} onToggle={() => set("reducedMotion", !prefs.reducedMotion)} />
          </div>

          {showAnimAdvanced && <AdvancedAnimations prefs={prefs} set={set} />}

          {!showAnimAdvanced && (
            <button
              type="button"
              onClick={() => setShowAnimAdvanced(true)}
              className="mt-2 w-full text-left text-[10px] uppercase tracking-wider font-semibold text-white/30 hover:text-white/60 transition-colors cursor-pointer px-3 py-2.5 rounded-lg border border-dashed border-white/[0.06] hover:border-white/[0.12] bg-white/[0.01] hover:bg-white/[0.03]"
            >
              ▸ Advanced
            </button>
          )}
          {showAnimAdvanced && (
            <button
              type="button"
              onClick={() => setShowAnimAdvanced(false)}
              className="mt-2 w-full text-left text-[10px] uppercase tracking-wider font-semibold text-white/30 hover:text-white/60 transition-colors cursor-pointer px-3 py-2.5 rounded-lg border border-dashed border-white/[0.06] hover:border-white/[0.12] bg-white/[0.01] hover:bg-white/[0.03]"
            >
              ▸ Simple
            </button>
          )}
        </div>
      </CollapsibleSection>

      {/* Layout */}
      <CollapsibleSection
        title="Layout & Density"
        description="Switch default spacing densitites and toggle sidebar layout profiles."
        icon="📏"
        badge={
          <span className="text-[10px] bg-white/5 border border-white/5 text-white/50 px-2 py-0.5 rounded font-mono font-medium">
            Density: {prefs.density}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Spacing Density</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Set overall element padding and row gap sizes
              </p>
            </div>
            <GlassSelect
              value={prefs.density}
              options={[
                { value: "compact", label: densityLabel("compact") },
                { value: "default", label: densityLabel("default") },
                { value: "spacious", label: densityLabel("spacious") },
              ]}
              onChange={(v) => set("density", v as any)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Sidebar Icons Only</span>
              <p className="text-[10px] text-white/35 mt-0.5 font-sans">
                Condense sidebar navigation tabs, hiding text labels
              </p>
            </div>
            <Toggle on={prefs.sidebarIconOnly} onToggle={() => set("sidebarIconOnly", !prefs.sidebarIconOnly)} />
          </div>
        </div>
      </CollapsibleSection>

    </div>
  );
}

// ─── Main Settings View ──────────────────────────────────────────────────────
export default function SettingsView({
  engineStatus,
  onRefresh,
  toast,
  devUnlocked,
}: {
  engineStatus: EngineStatus;
  onRefresh: () => void;
  toast: (msg: string, type?: ToastType) => void;
  devUnlocked: boolean;
}) {
  const [subTab, setSubTab] = useState<SettingsSubTab>("system");

  const [config, setConfig] = useState<AppConfig | null>(null);

  const loadConfig = useCallback(async () => {
    const res = await tauriApi("export_config");
    // A fresh install (no Config.json yet) returns {} — fall back to defaults
    // so section accesses (engine_settings, api_keys, …) never crash.
    if (res && typeof res === "object" && !("error" in res) && "engine_settings" in res) {
      setConfig(res as AppConfig);
    } else {
      setConfig(defaultConfig);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const saveSection = async (section: string) => {
    if (!config) return;
    try {
      const res = await saveConfig(config);
      toast(res, res.includes("success") ? "success" : "error");
    } catch {
      toast("Dev mode: config saved to memory (Tauri not connected)", "info");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-2xl font-bold text-white mb-6 shrink-0 tracking-tight">Settings</h2>

      {/* Sub-tabs container */}
      <div className="bg-white/[0.02] border border-white/5 p-1 rounded-2xl flex gap-1.5 overflow-x-auto shrink-0 mb-6 shadow-inner">
        <SubTabBtn
          active={subTab === "system"}
          onClick={() => setSubTab("system")}
          icon="🖥️"
          label="System"
        />
        <SubTabBtn
          active={subTab === "engine"}
          onClick={() => setSubTab("engine")}
          icon="⚙️"
          label="Engine"
        />
        <SubTabBtn
          active={subTab === "api-routing"}
          onClick={() => setSubTab("api-routing")}
          icon="🔑"
          label="API & Routing"
        />
        <SubTabBtn
          active={subTab === "theme"}
          onClick={() => setSubTab("theme")}
          icon="🎨"
          label="Theme"
        />
        <SubTabBtn
          active={subTab === "about"}
          onClick={() => setSubTab("about")}
          icon="ℹ️"
          label="About"
        />
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 overflow-y-auto min-h-0 pr-1">
        {subTab === "system" && <SystemSubTab toast={toast} config={config} setConfig={setConfig} onSaveConfig={saveSection} />}
        {subTab === "engine" && (
          <EngineSubTab engineStatus={engineStatus} onRefresh={onRefresh} toast={toast} devUnlocked={devUnlocked} />
        )}
        {subTab === "api-routing" && <ApiRoutingSubTab toast={toast} />}
        {subTab === "theme" && <ThemeSubTab toast={toast} />}
        {subTab === "about" && <AboutSubTab toast={toast} />}
      </div>
    </div>
  );
}
