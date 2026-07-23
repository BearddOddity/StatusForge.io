import React, { useState, useEffect, useRef, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { EngineStatus, AppConfig, SettingsSubTab, ToastType, ApiKeys } from "@statusforge/types";
import type { KeychainStatus } from "@statusforge/types";
import { fetchOverlayToken, getKeychainStatus, saveConfig, tauriApi } from "@statusforge/hooks/useTauriApi";
import {
  SubTabBtn,
  CollapsibleSection,
  Toggle,
  GlassSelect,
  SettingsPanel,
  EditRemoveButtons,
} from "@statusforge/components/SettingsComponents";
import OAuthConnectModal from "@statusforge/components/OAuthConnectModal";
import {
  type SystemPrefs,
  loadSystemPrefs,
  saveSystemPrefs,
  SYSTEM_PREFS_EVENT,
} from "@statusforge/systemPrefs";

import { clampInt } from "@statusforge/utils/number";

// ─── Engine Sub-tab ─────────────────────────────────────────────────────────
function EngineSubTab({
  engineStatus,
  toast,
}: {
  engineStatus: EngineStatus;
  onRefresh: () => void;
  toast: (msg: string, type?: ToastType) => void;
}) {
  const [overlayToken, setOverlayToken] = useState("Loading...");
  const [keychainInfo, setKeychainInfo] = useState<KeychainStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<string>("windows");
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
    setTimeout(() => {
      skipSave.current = false;
    }, 500);
  }, []);

  useEffect(() => {
    fetchOverlayToken()
      .then((t) => setOverlayToken(t))
      .catch(() => setOverlayToken(defaultConfig.engine_settings.overlay_token));
    getKeychainStatus()
      .then((s) => setKeychainInfo(s))
      .catch(() => setKeychainInfo({ stored: ["twitch_token", "kick_token"], count: 2 }));
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

  const regenerateOverlayToken = async () => {
    // Delegates to the backend (cryptographically-random bytes, saved
    // immediately) rather than generating one client-side — a token that
    // gates every overlay URL shouldn't be picked with Math.random().
    const result = await tauriApi("rotate_overlay_token");
    if (typeof result !== "string") {
      toast("Failed to regenerate overlay token", "error");
      return;
    }
    setOverlayToken(result);
    setEngine("overlay_token", result);
    toast("Overlay token regenerated", "success");
  };

  return (
    <div>
      {/* Control Panel */}
      <CollapsibleSection
        title="Control Panel"
        description="View engine status and manage the overlay token."
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
          The detection engine runs on port 53735. Platform:{" "}
          <strong className="text-white/70">{platform}</strong>.
          {platform === "macos" && (
            <span className="text-yellow-400/70">
              {" "}
              macOS requires the Screen Recording permission to read window titles.
            </span>
          )}
        </p>
        <div className="flex items-center gap-3 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <p className="text-white/60 text-xs flex-1">
            Overlay Token:{" "}
            <code className="bg-black/40 px-1.5 py-0.5 rounded font-mono text-white/90">
              {overlayToken === "Loading..." ? overlayToken : "•".repeat(overlayToken.length)}
            </code>
          </p>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(overlayToken);
              toast("Overlay token copied to clipboard", "success");
            }}
            title="Copy overlay token"
            className="p-1.5 rounded bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            onClick={regenerateOverlayToken}
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
      {config &&
        (() => {
          const isMacOS = platform === "macos";
          return (
            <CollapsibleSection
              title="Detection Engine & Pipeline"
              description="How the detection engine decides what you're playing."
              icon="🔄"
              badge={
                <span className="text-[10px] px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5 border transition-all duration-300 bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  {engineStatus.running ? "RUNNING" : "STOPPED"}
                </span>
              }
            >
              <p className="text-xs text-white/40 mb-4 leading-relaxed">
                Detection runs on Windows, macOS, and Linux.
                {isMacOS && (
                  <>
                    {" "}
                    On macOS, grant <strong className="text-yellow-300/80">
                      Screen Recording
                    </strong>{" "}
                    permission (System Settings → Privacy &amp; Security) so the engine can read
                    window titles.
                  </>
                )}
              </p>

              {/* Blipy dual-PC pairing (Hub side) */}
              <div className="mt-2 p-3 bg-blue-500/[0.04] border border-blue-500/15 rounded-xl">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs text-white/80 font-medium">Blipy Dual-PC Link</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 font-semibold">
                    OPTIONAL
                  </span>
                </div>
                <p className="text-[10px] text-white/30 mb-2">
                  Streaming from two PCs? Run Blipy on the gaming PC — this hub receives its
                  detections over the LAN and updates overlays exactly like local detection.
                </p>

                <div className="flex items-center justify-between p-2.5 mb-3 bg-white/[0.02] border border-white/5 rounded-lg">
                  <div>
                    <p className="text-xs text-white/70">Activate Link</p>
                    <p className="text-[10px] text-white/30 mt-0.5">
                      While active, this PC's local detection pauses — Blipy is the only engine
                      running, preventing the two sources from crosswiring.
                    </p>
                  </div>
                  <Toggle
                    on={config.engine_settings.blipy_link_active}
                    onToggle={() =>
                      setEngine("blipy_link_active", !config.engine_settings.blipy_link_active)
                    }
                  />
                </div>

                <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                  Network PIN
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={config.engine_settings.blipy_pin}
                  onChange={(e) =>
                    setEngine("blipy_pin", e.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  placeholder="0000"
                  className="input-glass !w-24 tracking-[0.5em] text-center placeholder:tracking-normal font-mono"
                />
                <p className="text-[10px] text-white/25 mt-1.5">
                  4-digit PIN — must match the PIN shown in Blipy on your gaming PC.
                </p>
              </div>

              {/* Pipeline section */}
              <div className="mt-6 pt-6 border-t border-white/[0.06]">
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/5 flex items-center justify-center text-lg shadow-inner shrink-0">
                    ⛓️
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-white/95 tracking-wide">
                      Detection Pipeline
                    </h4>
                    <p className="text-[11px] text-white/40 mt-0.5">
                      Configure the 6-stage detection pipeline.
                    </p>
                  </div>
                </div>

                <p className="text-xs text-white/40 mb-4 leading-relaxed">
                  Each running process passes through these stages, which decide whether it's a
                  game, gets filtered out, or needs a closer look.
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
                    <span className="text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)]">
                      {config.engine_settings.strict_forge_mode ? "Strict Lockdown" : "Standard"}
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
                          Matches instantly if the process is already in your library
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
                          Rejects anything that isn't explicitly in your library
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
                            <span className="text-xs text-white/80 font-medium">
                              Behavior Traps
                            </span>
                            <svg
                              className={`w-3 h-3 text-white/30 transition-transform duration-200 ${
                                trapsOpen ? "rotate-180" : ""
                              }`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </div>
                          <p className="text-[10px] text-white/30 mt-0.5">
                            Filters out non-game software using a handful of behavioral checks
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
                            <span className="text-xs text-white/70 font-medium">
                              Emulator Detection
                            </span>
                            <p className="text-[10px] text-white/35 mt-0.5">
                              Detect games inside popular emulators (Yuzu, RPCS3, Citra, etc.)
                            </p>
                            <p className="text-[10px] text-white/25 mt-1">
                              New to emulation?{" "}
                              <button
                                type="button"
                                onClick={() => openUrl("https://www.emudeck.com/")}
                                className="text-white/40 hover:text-white/60 underline cursor-pointer"
                              >
                                EmuDeck
                              </button>{" "}
                              is an easy, beginner-friendly way to set up RetroArch, Dolphin, PCSX2,
                              RPCS3, and more at once, and it installs straight into Steam.
                            </p>
                          </div>
                          <Toggle
                            on={config.engine_settings.emulator_detection}
                            onToggle={() =>
                              setEngine(
                                "emulator_detection",
                                !config.engine_settings.emulator_detection
                              )
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
                            <span className="text-xs font-mono font-semibold text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)]">
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
                            <span className="text-xs text-white/70 font-medium">
                              Chromium / Electron Trap
                            </span>
                            <p className="text-[10px] text-white/35 mt-0.5">
                              Filters out Discord, Spotify, VS Code, and other Electron/Chromium
                              apps
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
                            <span className="text-xs text-white/70 font-medium">
                              Command-Line Flag Trap
                            </span>
                            <p className="text-[10px] text-white/35 mt-0.5">
                              Filters out helper processes launched with utility/render flags
                            </p>
                          </div>
                          <Toggle
                            on={config.engine_settings.trap_cmdline}
                            onToggle={() =>
                              setEngine("trap_cmdline", !config.engine_settings.trap_cmdline)
                            }
                          />
                        </div>
                        {/* UI Framework Trap */}
                        <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                          <div>
                            <span className="text-xs text-white/70 font-medium">
                              UI Framework Trap
                            </span>
                            <p className="text-[10px] text-white/35 mt-0.5">
                              Filters out known desktop tools like Task Manager, File Explorer, etc.
                            </p>
                          </div>
                          <Toggle
                            on={config.engine_settings.trap_ui_framework}
                            onToggle={() =>
                              setEngine(
                                "trap_ui_framework",
                                !config.engine_settings.trap_ui_framework
                              )
                            }
                          />
                        </div>
                        {/* Window Geometry Trap */}
                        <div className="flex items-center justify-between border-t border-white/[0.03] pt-3">
                          <div>
                            <span className="text-xs text-white/70 font-medium">
                              Window Geometry Trap
                            </span>
                            <p className="text-[10px] text-white/35 mt-0.5">
                              Filters out background or invisible processes with no visible presence
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
                          Overrides everything else if Steam, Proton/Wine, or a known launcher
                          (Epic, EA, Uplay) confirms it
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
                            <span className="text-xs text-white/80 font-medium">
                              Score & Classify
                            </span>
                            <svg
                              className={`w-3 h-3 text-white/30 transition-transform duration-200 ${
                                scoreOpen ? "rotate-180" : ""
                              }`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </div>
                          <p className="text-[10px] text-white/30 mt-0.5">
                            Adds up weighted signals to decide if a process is a game
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
                              setEngine(
                                "score_engine_dna",
                                !config.engine_settings.score_engine_dna
                              )
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
                              <span className="text-xs text-white/70 font-medium">
                                Fullscreen Presence
                              </span>
                              <p className="text-[10px] text-white/35 mt-0.5">
                                The window is fullscreen
                              </p>
                            </div>
                          </div>
                          <Toggle
                            on={config.engine_settings.score_fullscreen}
                            onToggle={() =>
                              setEngine(
                                "score_fullscreen",
                                !config.engine_settings.score_fullscreen
                              )
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
                              <span className="text-xs text-white/70 font-medium">
                                Unique Window Title
                              </span>
                              <p className="text-[10px] text-white/35 mt-0.5">
                                Window title looks like a real name, not just an .exe
                              </p>
                            </div>
                          </div>
                          <Toggle
                            on={config.engine_settings.score_window_title}
                            onToggle={() =>
                              setEngine(
                                "score_window_title",
                                !config.engine_settings.score_window_title
                              )
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
                              <span className="text-xs text-white/70 font-medium">
                                Heavy RAM Allocation
                              </span>
                              <p className="text-[10px] text-white/35 mt-0.5">
                                Adds points when memory usage is above the RAM floor
                              </p>
                            </div>
                          </div>
                          <Toggle
                            on={config.engine_settings.score_ram}
                            onToggle={() =>
                              setEngine("score_ram", !config.engine_settings.score_ram)
                            }
                          />
                        </div>

                        {/* Score Threshold */}
                        <div className="border-t border-white/[0.03] pt-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <div>
                              <span className="text-xs text-white/70 font-medium">
                                Score Threshold
                              </span>
                              <p className="text-[10px] text-white/35 mt-0.5">
                                Minimum score needed to count as a game
                              </p>
                            </div>
                            <span className="text-xs font-mono font-semibold text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)]">
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
                            <span>0.0 — trust everything</span>
                            <span>
                              {(
                                (config.engine_settings.score_engine_dna ? 0.4 : 0) +
                                (config.engine_settings.score_fullscreen ? 0.3 : 0) +
                                (config.engine_settings.score_window_title ? 0.2 : 0) +
                                (config.engine_settings.score_ram ? 0.1 : 0)
                              ).toFixed(1)}{" "}
                              — strictest
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Stage 6: Forged Output */}
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3.5">
                      <span className="w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_15%)] text-[10px] font-bold flex items-center justify-center shrink-0">
                        6
                      </span>
                      <div>
                        <span className="text-xs text-white/80 font-medium">Forged Output</span>
                        <p className="text-[10px] text-white/30 mt-0.5">
                          Sends the detected game to your overlays and connected platforms
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
          description="How often the engine scans, and how overlays fade."
          icon="⏳"
          badge={
            <span className="text-[10px] bg-white/5 border border-white/5 text-white/50 px-2 py-0.5 rounded font-mono font-medium">
              Scan {config.engine_settings.scan_interval}s · Fade{" "}
              {config.engine_settings.overlay_fade_timer}s
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
                min={2}
                max={60}
                value={config.engine_settings.scan_interval}
                onChange={(e) => setEngine("scan_interval", clampInt(e.target.value, 2, 60, 2))}
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
                onChange={(e) => setEngine("grace_period", clampInt(e.target.value, 0, 120, 0))}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Overlay Poll Rate (s)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={config.engine_settings.overlay_poll_rate}
                onChange={(e) => setEngine("overlay_poll_rate", clampInt(e.target.value, 1, 60, 1))}
                className="input-glass font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
                Overlay Fade Timer (s)
              </label>
              <input
                type="number"
                min={0}
                max={120}
                value={config.engine_settings.overlay_fade_timer}
                onChange={(e) =>
                  setEngine("overlay_fade_timer", clampInt(e.target.value, 0, 120, 0))
                }
                className="input-glass font-mono"
              />
            </div>
          </div>
        </CollapsibleSection>
      )}

      {/* Idle State */}
      {config && (
        <CollapsibleSection
          title="Idle State"
          description="What to show when no game is running."
          icon="🌙"
          badge={
            <span className="text-[10px] bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] px-2.5 py-1 rounded-full font-semibold max-w-[120px] truncate">
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
          description="Send events to Streamer.bot over its local websocket."
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
        description="Move your saved tokens out of plain text and into your OS keychain."
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
          OAuth tokens are normally stored as plain text in Config.json. Migrating moves them into
          Windows Credential Manager / macOS Keychain and removes them from disk.
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
                // The "Protected"/"Plaintext config" badge and the stored-entries
                // list both read keychainInfo, which was only ever fetched once
                // on mount — without this, a successful migration left both
                // showing the pre-migration state until the user reopened
                // Settings.
                getKeychainStatus()
                  .then(setKeychainInfo)
                  .catch(() => {});
              }}
              className="btn-cta"
            >
              🔒 Migrate Tokens to Keychain
            </button>
          </div>

          {keychainInfo && keychainInfo.stored.length > 0 && (
            <div className="p-4 bg-white/[0.02] border border-white/5 rounded-xl">
              <span className="text-[10px] uppercase tracking-wider text-white/40 block mb-2 font-bold">
                Stored Keychain Entries ({keychainInfo.count})
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
// Deliberately empty/inert — never hardcode real keys, tokens, or IDs here.
// This is a fallback shown before any real config loads, not a fixture.
const defaultConfig: AppConfig = {
  api_keys: {
    steamgrid: "",
    rawg: "",
    igdb_client: "",
    igdb_secret: "",
    igdb_token: "",
    thegamesdb: "",
  },
  broadcaster: {
    routing_mode: "native" as const,
    twitch_client: "",
    twitch_secret: "",
    twitch_token: "",
    twitch_refresh: "",
    twitch_broadcaster_id: "",
    kick_client: "",
    kick_secret: "",
    kick_channel_id: "",
    kick_token: "",
    kick_refresh: "",
  },
  engine_settings: {
    idle_category: "Just Chatting",
    sb_port: 8080,
    scan_interval: 15,
    grace_period: 0,
    overlay_poll_rate: 8,
    safe_mode: false,
    auto_push: false,
    platform_push_enabled: true,
    overlay_fade_timer: 15,
    strict_forge_mode: false,
    sb_action_name: "UpdateCategory",
    overlay_token: "",
    blipy_pin: "0000",
    blipy_pairing_key: "",
    blipy_link_active: false,
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
  keyUrl: string;
  group?: { key: string; label: string }[];
}[] = [
  {
    key: "steamgrid",
    label: "SteamGridDB",
    desc: "Custom grid artwork, hero banners, and logo images",
    icon: "🖼️",
    keyUrl: "https://www.steamgriddb.com/profile/preferences/api",
  },
  {
    key: "rawg",
    label: "RAWG",
    desc: "Game metadata — genres, ratings, release dates, screenshots",
    icon: "🎮",
    keyUrl: "https://rawg.io/apidocs",
  },
  {
    key: "igdb",
    label: "IGDB",
    desc: "Twitch-authenticated IGDB API — game data, covers, screenshots, release dates",
    icon: "🎮",
    keyUrl: "https://dev.twitch.tv/console/apps",
    group: [
      { key: "igdb_client", label: "Client ID" },
      { key: "igdb_secret", label: "Client Secret" },
      { key: "igdb_token", label: "Access Token" },
    ],
  },
  {
    key: "thegamesdb",
    label: "TheGamesDB",
    desc: "Community-run game database — strong coverage for older/retro console games",
    icon: "🕹️",
    keyUrl: "https://thegamesdb.net/",
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
  keyUrl: string;
  userFields: { key: string; label: string; hint?: string; optional?: boolean }[];
  managedFields?: { key: string; label: string }[];
}[] = [
  {
    key: "twitch",
    label: "Twitch",
    desc: "OAuth2 via Twitch — game category updates, stream info, broadcaster identity",
    keyUrl: "https://dev.twitch.tv/console/apps",
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
      {
        key: "twitch_token",
        label: "Access Token (Optional)",
        hint: "Alternate to Client Secret — paste a token here if you generate one yourself (your own OAuth tool/callback). Client ID is still required; Twitch's API needs it on every request regardless of how the token was obtained.",
        optional: true,
      },
      {
        key: "twitch_broadcaster_id",
        label: "Broadcaster ID (Optional)",
        hint: 'Only needed alongside a manually-pasted Access Token — "Connect Twitch" fetches this automatically.',
        optional: true,
      },
    ],
    managedFields: [{ key: "twitch_refresh", label: "Refresh Token" }],
  },
  {
    key: "kick",
    label: "Kick",
    desc: "OAuth2 via Kick — channel updates, chat, stream metadata",
    keyUrl: "https://kick.com/settings/developer",
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
      {
        key: "kick_token",
        label: "Access Token (Optional)",
        hint: "Alternate to Client ID and Client Secret — paste a token here if you generate one yourself (your own OAuth tool/callback). Kick's API doesn't need either once you have a token.",
        optional: true,
      },
    ],
    managedFields: [{ key: "kick_refresh", label: "Refresh Token" }],
  },
];

// ─── API & Routing Sub-tab ──────────────────────────────
function ApiRoutingSubTab({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  const [section, setSection] = useState<"keys" | "routing">("keys");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const [floatingClosing, setFloatingClosing] = useState(false);
  const [floatingType, setFloatingType] = useState<"keys" | "routing">("keys");
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [oauthModal, setOauthModal] = useState<{ platform: "twitch" | "kick"; url: string } | null>(
    null
  );
  const [validatingPlatform, setValidatingPlatform] = useState<string | null>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const skipSave = useRef(false);

  const [showAccessTokens, setShowAccessTokens] = useState(
    () => loadSystemPrefs().showAccessTokens
  );
  useEffect(() => {
    const handler = () => setShowAccessTokens(loadSystemPrefs().showAccessTokens);
    window.addEventListener(SYSTEM_PREFS_EVENT, handler);
    return () => window.removeEventListener(SYSTEM_PREFS_EVENT, handler);
  }, []);

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
    setTimeout(() => {
      skipSave.current = false;
    }, 500);
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
        for (const g of entry.group)
          next[g.key as keyof ApiKeys] = next[g.key as keyof ApiKeys] || "";
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

  const truncate = (v: string) => (v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : "—");

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
    // Presence, not truthiness: addRouteFromCatalog sets a field to "" to
    // activate its card (so the user can type into it), and removeRouteEntry
    // deletes the key entirely to deactivate it. A truthy check meant a
    // freshly-added, still-empty platform never satisfied its own
    // activation check, so clicking "+ Add" silently did nothing.
    return allKeys.some((k) => k in config.broadcaster);
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
      for (const f of entry.userFields)
        next[f.key as keyof typeof next] = (next[f.key as keyof typeof next] || "") as any;
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

  // OAuth-backed entries (Twitch/Kick) route through disconnect_platform,
  // which deletes the keychain entry too — clearing fields alone leaves it
  // in place and the next config load just backfills it. Persists right
  // away, unlike removeRouteEntry's "save to confirm".
  const disconnectRoute = async (entry: (typeof ROUTING_CATALOG)[number]) => {
    try {
      await tauriApi("disconnect_platform", { platform: entry.key });
    } catch (e) {
      toast(`Failed to disconnect ${entry.label}: ${e}`, "error");
      return;
    }
    if (editingKey === entry.key) setEditingKey(null);
    // disconnect_platform already persisted the change to disk — reload
    // rather than locally clearing fields, so state matches what's saved.
    const res = await tauriApi("export_config").catch(() => null);
    if (res) setConfig(res as AppConfig);
    toast(`${entry.label} disconnected. Reconnect any time in API & Routing.`, "success");
  };

  // If a manually-pasted access token is already present, validate it
  // directly instead of launching the OAuth popup — that's the whole point
  // of the "Access Token (Optional)" field as an alternate connection path.
  const connectOrValidate = async (entry: (typeof ROUTING_CATALOG)[number]) => {
    const tokenKey = `${entry.key}_token`;
    const hasManualToken = !!bc[tokenKey as keyof typeof bc];
    if (!hasManualToken) {
      setOauthModal({ platform: entry.key as "twitch" | "kick", url: entry.connectUrl });
      return;
    }

    setValidatingPlatform(entry.key);
    const cmd = entry.key === "kick" ? "kick_validate_token" : "twitch_validate_token";
    const res = await tauriApi(cmd);
    setValidatingPlatform(null);

    if (res && typeof res === "object" && "error" in res) {
      toast(`${entry.label} token invalid: ${(res as { error: string }).error}`, "error");
      return;
    }
    toast(`Connected to ${entry.label} as ${res}`, "success");
    loadConfig();
  };

  // ── Floating card ─────────────────────────────────
  const renderFloatingCard = () => {
    if (!floatingOpen) return null;
    const isKeys = floatingType === "keys";
    const items = isKeys ? filteredAvailableKeys : filteredAvailableRoutes;
    const title = isKeys ? "Add API Key" : "Add Integration";
    const placeholder = isKeys ? "Search keys…" : "Search integrations…";
    const emptyMain = isKeys
      ? search
        ? "No matches"
        : "All keys added"
      : search
        ? "No matches"
        : "All integrations active";
    const emptySub = isKeys
      ? search
        ? "Try a different search term"
        : "You can manage keys in the list"
      : search
        ? "Try a different search term"
        : "You can manage integrations in the list";

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
          className={`relative w-[380px] h-full max-h-[600px] m-4 flex flex-col bg-black/20 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] ${
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
                  <span className="section-head-icon text-sm !w-8 !h-8 !rounded-lg">{k.icon}</span>
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
  const orphanKeyEntries: typeof displayKeyEntries = orphanApiKeys.map((k) => ({
    key: k,
    label: k,
    desc: "",
    icon: "🔑",
    keyUrl: "",
  }));
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
    keyUrl: "",
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
              ? "bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_15%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] border-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] shadow-md shadow-[color-mix(in_srgb,var(--user-accent,#9146ff)_5%,transparent)]"
              : "bg-transparent text-white/40 border-transparent hover:text-white/80 hover:bg-white/[0.04]"
          }`}
        >
          <span className="text-sm">🗝️</span>
          API Keys
          {keyCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-white/50">
              {keyCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setSection("routing")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 border cursor-pointer ${
            section === "routing"
              ? "bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_15%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] border-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] shadow-md shadow-[color-mix(in_srgb,var(--user-accent,#9146ff)_5%,transparent)]"
              : "bg-transparent text-white/40 border-transparent hover:text-white/80 hover:bg-white/[0.04]"
          }`}
        >
          <span className="text-sm">♾️</span>
          Routing
          {routeCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-white/50">
              {routeCount}
            </span>
          )}
        </button>
      </div>

      {/* API Keys section */}
      {section === "keys" && (
        <SettingsPanel>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-white font-semibold">API Keys</h3>
            <button
              onClick={() => openFloating("keys")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_15%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] hover:border-[color-mix(in_srgb,var(--user-accent,#9146ff)_40%,transparent)] transition-all cursor-pointer"
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
                const isGroup = "group" in entry && !!(entry as any).group;
                const isEditing = editingKey === entry.key;
                const filledCount = isGroup
                  ? (entry as any).group.filter(
                      (g: { key: string }) => !!apiKeys[g.key as keyof ApiKeys]
                    ).length
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
                        ? "bg-white/[0.04] border-[color-mix(in_srgb,var(--user-accent,#9146ff)_30%,transparent)]"
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
                        <span className="text-xs text-white/80 font-medium block">
                          {entry.label}
                        </span>
                        <span className="text-[10px] text-white/30 block truncate font-mono">
                          {subFilled}
                        </span>
                      </div>

                      <EditRemoveButtons
                        isEditing={isEditing}
                        onToggleEdit={() => setEditingKey(isEditing ? null : entry.key)}
                        onOpenLink={entry.keyUrl ? () => openUrl(entry.keyUrl).catch(() => {}) : undefined}
                        onRemove={() => removeKeyEntry(entry as (typeof KEY_CATALOG)[number])}
                      />
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_15%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_25%,transparent)] hover:border-[color-mix(in_srgb,var(--user-accent,#9146ff)_40%,transparent)] transition-all cursor-pointer"
            >
              <span className="text-sm leading-none">+</span>
              Add Integration
            </button>
          </div>

          <div className="flex items-center justify-between py-3 mb-2 border-b border-white/[0.05]">
            <div>
              <span className="text-xs text-white/80 font-medium">Platform Detection</span>
              <p className="text-[10px] text-white/30 mt-0.5">
                Send detected game state to Twitch / Kick. Turn off to keep detection local-only.
              </p>
            </div>
            <Toggle
              on={config.engine_settings.platform_push_enabled}
              onToggle={() => {
                const next = !config.engine_settings.platform_push_enabled;
                setConfig((prev) =>
                  prev
                    ? {
                        ...prev,
                        engine_settings: { ...prev.engine_settings, platform_push_enabled: next },
                      }
                    : prev
                );
                // Off leaves the last-pushed category as-is; on picks up an
                // in-progress session immediately instead of waiting for the
                // next game switch.
                if (next) tauriApi("refresh_platform_push");
              }}
            />
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
              <p className="text-[10px] text-white/20">
                Click "Add Integration" to connect Twitch or Kick
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {allRouteDisplay.map((entry) => {
                const isEditing = editingKey === entry.key;
                const requiredFields = entry.userFields.filter((f) => !f.optional);
                const userFilled = requiredFields.filter(
                  (f) => !!bc[f.key as keyof typeof bc]
                ).length;
                const userTotal = requiredFields.length;
                const managedFields =
                  "managedFields" in entry
                    ? ((entry as any).managedFields as { key: string; label: string }[] | undefined)
                    : undefined;
                const hasOauth =
                  managedFields?.some((f: { key: string }) => !!bc[f.key as keyof typeof bc]) ??
                  false;
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
                        ? "bg-white/[0.04] border-[color-mix(in_srgb,var(--user-accent,#9146ff)_30%,transparent)]"
                        : "bg-white/[0.02] border-white/[0.06] hover:border-white/10"
                    }`}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          hasValue
                            ? allFilled || hasOauth
                              ? "bg-green-400"
                              : "bg-yellow-400"
                            : "bg-white/15"
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
                        onOpenLink={entry.keyUrl ? () => openUrl(entry.keyUrl).catch(() => {}) : undefined}
                        onRemove={() =>
                          managedFields && managedFields.length > 0
                            ? disconnectRoute(entry as (typeof ROUTING_CATALOG)[number])
                            : removeRouteEntry(entry as (typeof ROUTING_CATALOG)[number])
                        }
                        removeLabel={
                          managedFields && managedFields.length > 0 ? "Disconnect" : "Remove"
                        }
                      />
                    </div>

                    {isEditing && (
                      <div className="px-4 pb-3 pt-0">
                        <div className="ml-9 flex flex-col gap-3">
                          <div className="flex flex-col gap-2.5">
                            {entry.userFields.map((f) => {
                              // Access Token specifically (not Client Secret,
                              // not Refresh Token) is hidden entirely — label,
                              // input, and hint all disappear — unless "Show
                              // Access Tokens" is on (Settings > System >
                              // Network).
                              if (f.key.includes("token") && !showAccessTokens) return null;
                              return (
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
                                  {f.hint && (
                                    <p className="text-[10px] text-white/20 mt-1 leading-snug">
                                      {f.hint}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {entry.connectUrl &&
                            (() => {
                              const hasManualToken = !!bc[`${entry.key}_token` as keyof typeof bc];
                              const isValidating = validatingPlatform === entry.key;
                              return (
                                <button
                                  onClick={() => connectOrValidate(entry)}
                                  disabled={isValidating}
                                  className="btn-cta"
                                >
                                  {isValidating
                                    ? "Verifying…"
                                    : hasManualToken
                                      ? `✓ Verify ${entry.label} Token`
                                      : `🔗 Connect ${entry.label}`}
                                </button>
                              );
                            })()}

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
                                      <span className="text-[10px] text-white/40 block">
                                        {f.label}
                                      </span>
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
            toast(
              oauthModal.platform.charAt(0).toUpperCase() +
                oauthModal.platform.slice(1) +
                " connected!",
              "success"
            );
          }}
        />
      )}
    </div>
  );
}

// ─── About Sub-tab ───────────────────────────────────────────────────────────
function AboutSubTab({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  return (
    <div>
      <CollapsibleSection
        title="About"
        description="App version, platform, and where your data lives."
        icon="ℹ️"
        defaultOpen={true}
        badge={
          <span className="text-[10px] bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] px-2.5 py-1 rounded-full font-semibold">
            StatusForge v{appVersion || "…"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: "App Version", value: appVersion || "…", icon: "🚀" },
            { label: "Tauri Version", value: "2.x", icon: "🦀" },
            { label: "Platform", value: navigator.platform, icon: "💻" },
            { label: "Local Database", value: "Forge_Database.json", icon: "📂" },
            { label: "Keychain", value: "Active", icon: "🛡️" },
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
            onClick={() => toast("Info refreshed", "success")}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] border border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90 transition-all cursor-pointer"
          >
            Refresh Info
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ─── System Sub-tab ───────────────────────────────────────────────────────────
// SystemPrefs interface/defaults/apply live in src/systemPrefs.ts (shared with
// App.tsx boot wiring and useWebSocket).


function SystemSubTab({
  toast,
}: {
  toast: (msg: string, type?: ToastType) => void;
  config: AppConfig | null;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  onSaveConfig: (section: string) => Promise<void>;
}) {
  const [prefs, setPrefs] = useState<SystemPrefs>(loadSystemPrefs);

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

  const exportGameDatabase = async () => {
    const res = await tauriApi("export_game_database");
    if (typeof res === "string") {
      toast(`Database exported to ${res}`, "success");
    } else {
      const err =
        res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
      toast(err ? `Export failed: ${err}` : "Export failed", "error");
    }
  };

  const exportMetadataReadme = async () => {
    const res = await tauriApi("export_metadata_readme");
    if (typeof res === "string") {
      toast(`Library table saved to ${res}`, "success");
    } else {
      const err =
        res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
      toast(err ? `Export failed: ${err}` : "Export failed", "error");
    }
  };

  // Bulk counterpart of the per-game import in the Add Game popup — reads
  // the picked file in the browser sandbox (no backend path access) and
  // hands the raw JSON to import_game_database, which does the actual
  // signature check/merge. A signed file from BearddOddity's curated
  // database gets applied field-for-field (still respecting any locks);
  // anything else only fills in blanks.
  const importLibraryFile = async (file: File) => {
    let json: string;
    try {
      json = await file.text();
    } catch {
      toast("Couldn't read that file", "error");
      return;
    }
    const res = await tauriApi("import_game_database", { json });
    if (typeof res === "string") {
      toast(res, "success");
    } else {
      const err =
        res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
      toast(err ? `Import failed: ${err}` : "Import failed", "error");
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
        description="Control what happens when your computer starts."
        icon="🚀"
        badge={
          <span className="text-[10px] bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] px-2.5 py-1 rounded-full font-semibold">
            {startupCount} / 3 Enabled
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Launch on Login</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Start StatusForge automatically when you log in
              </p>
            </div>
            <Toggle on={prefs.launchOnLogin} onToggle={toggleLaunchOnLogin} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Auto-start Engine</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Start the detection engine as soon as StatusForge opens
              </p>
            </div>
            <Toggle on={prefs.autoStartEngine} onToggle={() => toggle("autoStartEngine")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Minimize to Tray</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Closing the window keeps StatusForge running in the tray instead of quitting
              </p>
            </div>
            <Toggle on={prefs.minimizeToTray} onToggle={() => toggle("minimizeToTray")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Display */}
      <CollapsibleSection
        title="Display & Hardware"
        description="Use your GPU for smoother animations and rendering."
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
              Use your GPU to render the window (reduces lag)
            </p>
          </div>
          <Toggle on={prefs.hardwareAccel} onToggle={() => toggle("hardwareAccel")} />
        </div>
      </CollapsibleSection>

      {/* Notifications */}
      <CollapsibleSection
        title="Alert Notifications"
        description="Get desktop notifications for important events."
        icon="🔔"
        badge={
          <span className="text-[10px] bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] px-2.5 py-1 rounded-full font-semibold">
            {notifyCount} / 3 Active
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Master Notifications</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Turn all desktop notifications on or off
              </p>
            </div>
            <Toggle on={prefs.showNotifications} onToggle={() => toggle("showNotifications")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Game Detection Alerts</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Notify you when a new game is detected
              </p>
            </div>
            <Toggle on={prefs.notifyOnGameDetect} onToggle={() => toggle("notifyOnGameDetect")} />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Category Update Alerts</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Notify you when your Twitch / Kick category updates
              </p>
            </div>
            <Toggle
              on={prefs.notifyOnStreamEvents}
              onToggle={() => toggle("notifyOnStreamEvents")}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* Integrations */}
      <CollapsibleSection
        title="Integrations"
        description="Publish live status events to a custom webhook."
        icon="🎮"
        badge={
          <span className="text-[10px] bg-[color-mix(in_srgb,var(--user-accent,#9146ff)_10%,transparent)] border border-[color-mix(in_srgb,var(--user-accent,#9146ff)_20%,transparent)] text-[color-mix(in_srgb,var(--user-accent,#9146ff)_100%,white_30%)] px-2.5 py-1 rounded-full font-semibold">
            {integrationsCount} / 1 Hooked
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium">Custom Webhook</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Send live status events to your own URL
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
        title="Network"
        description="Control how dropped connections are handled."
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
              Automatically reconnect if the connection to the engine drops
            </p>
          </div>
          <Toggle on={prefs.wsAutoReconnect} onToggle={() => toggle("wsAutoReconnect")} />
        </div>
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06]">
          <div>
            <span className="text-xs text-white/75 font-medium font-sans">Show Access Tokens</span>
            <p className="text-[10px] text-white/35 mt-0.5">
              Reveal Access/Refresh Token previews in API &amp; Routing. Off by default — they stay
              masked.
            </p>
          </div>
          <Toggle on={prefs.showAccessTokens} onToggle={() => toggle("showAccessTokens")} />
        </div>
      </CollapsibleSection>

      {/* Logging & Data */}
      <CollapsibleSection
        title="Logs & Updates"
        description="Manage logging, config backups, and app updates."
        icon="📓"
        badge={
          <span
            className={`text-[10px] px-2 py-0.5 rounded font-mono font-medium uppercase border ${
              prefs.updateChannel === "closed-beta"
                ? "bg-red-500/10 border-red-500/20 text-red-400"
                : prefs.updateChannel === "beta"
                  ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"
                  : "bg-white/5 border-white/5 text-white/50"
            }`}
          >
            {prefs.updateChannel === "closed-beta" ? "Closed Beta" : prefs.updateChannel} · Log{" "}
            {prefs.logLevel}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">Debug Log Level</span>
              <p className="text-[10px] text-white/35 mt-0.5">How much detail gets logged</p>
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
              <p className="text-[10px] text-white/35 mt-0.5">Display language</p>
            </div>
            <GlassSelect
              value={prefs.language}
              options={[{ value: "en", label: "English (US)" }]}
              onChange={(v) => set("language", v)}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium font-sans">
                Automatically Check for Updates
              </span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Check GitHub releases once per launch. Installing an update is always your call.
              </p>
            </div>
            <Toggle
              on={prefs.autoUpdateCheckEnabled}
              onToggle={() => toggle("autoUpdateCheckEnabled")}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.03] pt-4">
            <div>
              <span className="text-xs text-white/75 font-medium">Update Channel</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Choose between stable and early-access builds
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
              <span className="text-xs text-white/75 font-medium">Dev Tools</span>
              <p className="text-[10px] text-white/35 mt-0.5">
                Show the Dev Tools sidebar tab (log terminal + diagnostics)
              </p>
            </div>
            <Toggle on={prefs.showDevTools} onToggle={() => toggle("showDevTools")} />
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Game Database"
        description="Back up or share your library's metadata, or import a curated database."
        icon="🗄️"
      >
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={exportGameDatabase}
            className="btn-ghost"
            title="Full raw backup of every scraped field for every game (JSON)"
          >
            Export Full Database (.json)
          </button>
          <button
            onClick={exportMetadataReadme}
            className="btn-ghost"
            title="Shareable Markdown table (cover, title, genre, year, dev, publisher) — paste into a GitHub README"
          >
            Export Shareable Library Table (.md)
          </button>
          <label
            className="btn-ghost cursor-pointer"
            title="Import a shared or BearddOddity-verified game database (JSON) — signed entries overwrite matching fields, unsigned ones only fill in blanks"
          >
            Import Library (.json)
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importLibraryFile(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </CollapsibleSection>

      {/* Actions */}
      <div className="flex gap-3 mt-5 flex-wrap">
        <button onClick={exportConfig} className="btn-ghost">
          Export Config
        </button>
        <button
          onClick={() => {
            saveSystemPrefs({ ...loadSystemPrefs(), onboardingComplete: false });
            toast("Setup guide reopened", "info");
          }}
          className="btn-ghost"
        >
          Replay Setup Guide
        </button>
      </div>
    </div>
  );
}

// ─── Theme Sub-tab ────────────────────────────────────────────────────────────
// Appearance now lives entirely in StreamerSuite's centralized Settings ->
// Appearance tab (src/components/settings/ThemeTab.tsx) — same storage
// (src/apps/statusforge/theme.ts reads/writes the unified settings key), so
// this sub-tab is just a pointer rather than a second copy of every control.
function ThemeSubTab() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-4 text-2xl">
        🎨
      </div>
      <p className="text-sm text-white/60 max-w-xs">
        Appearance is managed in one place now — accent color, background, fonts, and effects all
        live in StreamerSuite&apos;s centralized Settings.
      </p>
      <p className="text-[11px] text-white/25 mt-2">
        Open StreamerSuite Settings &rarr; Appearance to make changes. They apply here
        automatically.
      </p>
    </div>
  );
}

// ─── Main Settings View ──────────────────────────────────────────────────────
export default function SettingsView({
  engineStatus,
  onRefresh,
  toast,
}: {
  engineStatus: EngineStatus;
  onRefresh: () => void;
  toast: (msg: string, type?: ToastType) => void;
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

  const saveSection = async (_section: string) => {
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
        {subTab === "system" && (
          <SystemSubTab
            toast={toast}
            config={config}
            setConfig={setConfig}
            onSaveConfig={saveSection}
          />
        )}
        {subTab === "engine" && (
          <EngineSubTab engineStatus={engineStatus} onRefresh={onRefresh} toast={toast} />
        )}
        {subTab === "api-routing" && <ApiRoutingSubTab toast={toast} />}
        {subTab === "theme" && <ThemeSubTab />}
        {subTab === "about" && <AboutSubTab toast={toast} />}
      </div>
    </div>
  );
}
