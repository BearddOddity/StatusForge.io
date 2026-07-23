import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { AppConfig, EngineStatus } from "@statusforge/types";
import { fetchConfig, saveConfig, fetchOverlayToken, tauriApi } from "@statusforge/hooks/useTauriApi";
import OAuthConnectModal from "@statusforge/components/OAuthConnectModal";
import { loadSystemPrefs, saveSystemPrefs } from "@statusforge/systemPrefs";

interface Props {
  onFinish: () => void;
  onBrowseOverlays: () => void;
  // Hides the wizard's rendered output without unmounting it, so its `step`
  // (and everything else in local state) survives a trip to the Dashboard to
  // browse overlay styles and back via the "Resume Setup Guide" pill.
  hidden?: boolean;
}

type Platform = "twitch" | "kick";

const PLATFORM_INFO: Record<
  Platform,
  {
    label: string;
    color: string;
    gradient: string;
    connectUrl: string;
    devConsoleUrl: string;
    setupHint: string;
    clientTypeHint: string;
    redirectUri: string;
    clientIdKey: keyof AppConfig["broadcaster"];
    clientSecretKey: keyof AppConfig["broadcaster"];
    tokenKey: keyof AppConfig["broadcaster"];
    refreshKey: keyof AppConfig["broadcaster"];
  }
> = {
  twitch: {
    label: "Twitch",
    color: "#9146FF",
    gradient: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)",
    connectUrl: "http://127.0.0.1:53735/twitch/login",
    devConsoleUrl: "https://dev.twitch.tv/console/apps/create",
    setupHint:
      'Give the app any name, set Category to "Application Integration," paste the redirect URL below, then hit Create. Open the app and copy the Client ID — click "New Secret" to generate the Client Secret.',
    clientTypeHint: 'When asked for OAuth Client Type, pick "Confidential" — not Public.',
    redirectUri: "https://127.0.0.1:53735/oauth/callback/twitch",
    clientIdKey: "twitch_client",
    clientSecretKey: "twitch_secret",
    tokenKey: "twitch_token",
    refreshKey: "twitch_refresh",
  },
  kick: {
    label: "Kick",
    color: "#00e676",
    gradient: "linear-gradient(135deg, #00e676 0%, #00b248 100%)",
    connectUrl: "http://127.0.0.1:53735/kick/login",
    devConsoleUrl: "https://kick.com/settings/developer",
    setupHint:
      'Click "Create Application," give it any name, and paste the redirect URL below. Once it\'s created, copy the Client ID and Client Secret it shows you.',
    clientTypeHint: 'When asked for Client Type, pick "Confidential" — not Public.',
    redirectUri: "http://localhost:53735/oauth/callback/kick",
    clientIdKey: "kick_client",
    clientSecretKey: "kick_secret",
    tokenKey: "kick_token",
    refreshKey: "kick_refresh",
  },
};

const STEP_LABELS = [
  "Welcome",
  "Connect",
  "Overlay",
  "Cover Art",
  "Detection",
  "Exit Behavior",
  "Performance",
  "Done",
];
const STEAMGRIDDB_API_URL = "https://www.steamgriddb.com/profile/preferences/api";

export default function OnboardingWizard({ onFinish, onBrowseOverlays, hidden }: Props) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Both platforms are set up independently on the same screen — this only
  // tracks which one's form is expanded/being connected right now, not an
  // exclusive choice of platform.
  const [expanded, setExpanded] = useState<Platform | null>("twitch");
  const [oauthPlatform, setOauthPlatform] = useState<Platform>("twitch");
  const [saving, setSaving] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [copiedRedirect, setCopiedRedirect] = useState<Platform | null>(null);
  const [overlayToken, setOverlayToken] = useState("");
  const [overlayCopied, setOverlayCopied] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [sgdbSaved, setSgdbSaved] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(() => loadSystemPrefs().minimizeToTray);
  const [hardwareAccel, setHardwareAccel] = useState(() => loadSystemPrefs().hardwareAccel);
  const [startingEngine, setStartingEngine] = useState(false);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);

  // Live detection status, only while the user's actually looking at that
  // step — no point polling in the background for a step they've moved on
  // from.
  useEffect(() => {
    if (step !== 4) return;
    let cancelled = false;
    const poll = async () => {
      const res = await tauriApi("get_engine_status");
      if (!cancelled && res && typeof res === "object" && !("error" in res)) {
        setEngineStatus(res as EngineStatus);
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step]);

  useEffect(() => {
    if (step === 2 && !overlayToken) {
      fetchOverlayToken().then(setOverlayToken);
    }
  }, [step, overlayToken]);

  const bc = config?.broadcaster;
  const isConnectedTo = (p: Platform) => {
    const i = PLATFORM_INFO[p];
    return !!(bc && (bc[i.tokenKey] || bc[i.refreshKey]));
  };
  const twitchConnected = isConnectedTo("twitch");
  const kickConnected = isConnectedTo("kick");
  const anyConnected = twitchConnected || kickConnected;

  const setField = (key: string, value: string) => {
    setConfig((prev) =>
      prev ? { ...prev, broadcaster: { ...prev.broadcaster, [key]: value } } : prev
    );
  };

  const persistAndConnect = async (p: Platform) => {
    if (!config) return;
    setSaving(true);
    try {
      await saveConfig(config);
    } finally {
      setSaving(false);
    }
    setOauthPlatform(p);
    setOauthOpen(true);
  };

  const onOAuthSuccess = () => {
    fetchConfig().then(setConfig);
  };

  const copyRedirect = (p: Platform) => {
    navigator.clipboard?.writeText(PLATFORM_INFO[p].redirectUri);
    setCopiedRedirect(p);
    setTimeout(() => setCopiedRedirect(null), 1500);
  };

  const copyOverlayUrl = () => {
    const url = `http://127.0.0.1:53735/forge-overlay/${overlayToken}/Horizontal_Left.html`;
    navigator.clipboard?.writeText(url);
    setOverlayCopied(true);
    setTimeout(() => setOverlayCopied(false), 1500);
  };

  const sgdbKey = config?.api_keys.steamgrid || "";
  const setSgdbKey = (value: string) => {
    setConfig((prev) =>
      prev ? { ...prev, api_keys: { ...prev.api_keys, steamgrid: value } } : prev
    );
  };
  const saveSgdbKey = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveConfig(config);
      setSgdbSaved(true);
      setTimeout(() => setSgdbSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const chooseExitBehavior = (toTray: boolean) => {
    setMinimizeToTray(toTray);
    saveSystemPrefs({ ...loadSystemPrefs(), minimizeToTray: toTray });
  };

  const choosePerformance = (accel: boolean) => {
    setHardwareAccel(accel);
    saveSystemPrefs({ ...loadSystemPrefs(), hardwareAccel: accel });
  };

  const startEngine = async () => {
    setStartingEngine(true);
    try {
      await tauriApi("start_engine");
      const res = await tauriApi("get_engine_status");
      if (res && typeof res === "object" && !("error" in res)) {
        setEngineStatus(res as EngineStatus);
      }
    } finally {
      setStartingEngine(false);
    }
  };

  const isLast = step === STEP_LABELS.length - 1;
  const detected = engineStatus?.is_playing && engineStatus.game_title;

  if (hidden) return null;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />

      <div className="relative w-[92vw] max-w-[480px] flex flex-col items-center text-center">
        <div
          className="w-full rounded-2xl overflow-hidden"
          style={{
            background: "rgba(0, 0, 0, calc(0.35 + var(--user-panel-opacity, 0.3) * 0.5))",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            boxShadow: "0 32px 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
          }}
        >
          <div
            className="h-[2px] w-full"
            style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
          />

          <div className="px-7 pt-8 pb-7">
            {/* Progress dots */}
            <div className="flex items-center justify-center gap-1.5 mb-6">
              {STEP_LABELS.map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === step ? "20px" : "6px",
                    backgroundColor: i <= step ? "#9146FF" : "rgba(255,255,255,0.15)",
                  }}
                />
              ))}
            </div>

            {/* ── Step 0: Welcome ─────────────────────────────────────── */}
            {step === 0 && (
              <>
                <div className="text-4xl mb-4">👋</div>
                <h3 className="text-white font-bold text-lg mb-2">Welcome to StatusForge</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-7 max-w-[340px] mx-auto">
                  Let's get you set up — a few quick steps, each with a real thing to click, not
                  just words to read. Skip anything you want and pick it up later in Settings.
                </p>
                <button
                  onClick={() => setStep(1)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Let's go
                </button>
              </>
            )}

            {/* ── Step 1: Connect platforms ───────────────────────────── */}
            {step === 1 && (
              <>
                <div className="text-4xl mb-4">🔗</div>
                <h3 className="text-white font-bold text-lg mb-2">Connect Twitch and Kick</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  Set up either one, or both — StatusForge updates every platform you connect at the
                  same time.
                </p>

                <div className="flex flex-col gap-2.5 w-full mb-5">
                  {(["twitch", "kick"] as Platform[]).map((p) => {
                    const i = PLATFORM_INFO[p];
                    const connected = isConnectedTo(p);
                    const clientId = (bc?.[i.clientIdKey] as string) || "";
                    const clientSecret = (bc?.[i.clientSecretKey] as string) || "";
                    const isExpanded = expanded === p;

                    return (
                      <div
                        key={p}
                        className="w-full rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden"
                      >
                        <button
                          onClick={() => setExpanded(isExpanded ? null : p)}
                          className="w-full flex items-center justify-between gap-2.5 px-4 py-3 cursor-pointer"
                        >
                          <div className="flex items-center gap-2.5">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{
                                background: connected ? "#34d399" : "rgba(255,255,255,0.25)",
                              }}
                            />
                            <span className="text-white text-[13px] font-semibold">{i.label}</span>
                            {connected && (
                              <span className="text-emerald-400 text-[10px] font-medium uppercase tracking-wide">
                                Connected
                              </span>
                            )}
                          </div>
                          <span className="text-white/30 text-[11px] select-none">
                            {isExpanded ? "Hide ▲" : connected ? "Manage ▾" : "Set up ▾"}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="px-4 pb-4 text-left">
                            {connected ? (
                              <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                <span className="text-emerald-400 text-sm">✓</span>
                                <span className="text-emerald-300 text-[11px] font-medium">
                                  {i.label} is connected and ready to update.
                                </span>
                              </div>
                            ) : (
                              <>
                                <div className="mb-3">
                                  <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                                    1. Register an app on {i.label}
                                  </span>
                                  <button
                                    onClick={() => openUrl(i.devConsoleUrl).catch(() => {})}
                                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold cursor-pointer border border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white transition-all"
                                  >
                                    Open {i.label} Developer Console ↗
                                  </button>
                                  <p className="text-white/35 text-[10.5px] leading-relaxed mt-1.5">
                                    {i.setupHint}
                                  </p>
                                  <p className="text-amber-300/70 text-[10.5px] leading-relaxed mt-1.5">
                                    ⚠ {i.clientTypeHint}
                                  </p>
                                </div>

                                <div className="mb-3">
                                  <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                                    2. Set its OAuth Redirect URL to
                                  </span>
                                  <button
                                    onClick={() => copyRedirect(p)}
                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 cursor-pointer hover:border-white/20 transition-all"
                                  >
                                    <code className="text-[10px] text-white/70 font-mono truncate">
                                      {i.redirectUri}
                                    </code>
                                    <span className="text-[10px] text-white/40 shrink-0">
                                      {copiedRedirect === p ? "Copied ✓" : "Copy"}
                                    </span>
                                  </button>
                                </div>

                                <div className="mb-3">
                                  <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                                    3. Paste its Client ID and Secret
                                  </span>
                                  <div className="flex flex-col gap-2">
                                    <input
                                      value={clientId}
                                      onChange={(e) => setField(i.clientIdKey, e.target.value)}
                                      placeholder="Client ID"
                                      className="input-glass"
                                    />
                                    <input
                                      type="password"
                                      value={clientSecret}
                                      onChange={(e) => setField(i.clientSecretKey, e.target.value)}
                                      placeholder="Client Secret"
                                      className="input-glass"
                                    />
                                  </div>
                                </div>

                                <button
                                  onClick={() => persistAndConnect(p)}
                                  disabled={!clientId.trim() || !clientSecret.trim() || saving}
                                  className="w-full py-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer text-white disabled:opacity-40 disabled:cursor-default"
                                  style={{ background: i.gradient }}
                                >
                                  {saving ? "Saving…" : `Connect ${i.label}`}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setStep(2)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                    style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                  >
                    Continue
                  </button>
                  {!anyConnected && (
                    <button
                      onClick={() => setStep(2)}
                      className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                    >
                      I'll do this later
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── Step 2: Overlay ─────────────────────────────────────── */}
            {step === 2 && (
              <>
                <div className="text-4xl mb-4">🖼️</div>
                <h3 className="text-white font-bold text-lg mb-2">Add an overlay (optional)</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  Shows what you're playing right on stream. Copy the URL below into an OBS Browser
                  Source — that's the whole setup.
                </p>

                <button
                  onClick={copyOverlayUrl}
                  disabled={!overlayToken}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 cursor-pointer hover:border-white/20 transition-all mb-3 disabled:opacity-40"
                >
                  <code className="text-[10px] text-white/70 font-mono truncate">
                    {overlayToken
                      ? `.../forge-overlay/${"•".repeat(8)}/Horizontal_Left.html`
                      : "Loading…"}
                  </code>
                  <span className="text-[10px] text-white/40 shrink-0">
                    {overlayCopied ? "Copied ✓" : "Copy URL"}
                  </span>
                </button>

                <button
                  onClick={onBrowseOverlays}
                  className="text-[11px] text-white/40 hover:text-white/60 transition-colors cursor-pointer mb-5"
                >
                  Browse other overlay styles in the Dashboard →
                </button>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setStep(3)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                    style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                  >
                    Skip
                  </button>
                </div>
              </>
            )}

            {/* ── Step 3: Cover art (SteamGridDB key) ─────────────────── */}
            {step === 3 && (
              <>
                <div className="text-4xl mb-4">🖼️</div>
                <h3 className="text-white font-bold text-lg mb-2">Better cover art (optional)</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  StatusForge can pull box art from SteamGridDB for games that don't have one built
                  in yet — grab a free key and paste it below.
                </p>

                <div className="w-full text-left mb-5">
                  <div className="mb-3">
                    <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                      1. Get an API key from SteamGridDB
                    </span>
                    <button
                      onClick={() => openUrl(STEAMGRIDDB_API_URL).catch(() => {})}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold cursor-pointer border border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white transition-all"
                    >
                      Open SteamGridDB API Preferences ↗
                    </button>
                    <p className="text-white/35 text-[10.5px] leading-relaxed mt-1.5">
                      Log in (or make a free account), then click "Generate" under API Key if you
                      don't already have one, and copy the key it shows you.
                    </p>
                  </div>

                  <div className="mb-1">
                    <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                      2. Paste it here
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        value={sgdbKey}
                        onChange={(e) => setSgdbKey(e.target.value)}
                        placeholder="SteamGridDB API Key"
                        className="input-glass flex-1"
                      />
                      <button
                        onClick={saveSgdbKey}
                        disabled={!sgdbKey.trim() || saving}
                        className="px-4 py-2 rounded-lg text-[11px] font-semibold cursor-pointer text-white disabled:opacity-40 disabled:cursor-default shrink-0"
                        style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                      >
                        {saving ? "Saving…" : sgdbSaved ? "Saved ✓" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setStep(4)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                    style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => setStep(4)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                  >
                    Skip
                  </button>
                </div>
              </>
            )}

            {/* ── Step 4: Live detection check ────────────────────────── */}
            {step === 4 && (
              <>
                <div className="text-4xl mb-4">🎮</div>
                <h3 className="text-white font-bold text-lg mb-2">Try it out</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  Launch anything you'd normally play — StatusForge checks what's running in the
                  background, including most emulators, and figures out the game on its own.
                </p>

                <div
                  className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border mb-1 ${
                    detected
                      ? "bg-emerald-500/10 border-emerald-500/20"
                      : "bg-white/[0.03] border-white/10"
                  }`}
                >
                  {detected ? (
                    <>
                      <span className="text-emerald-400 text-base">✓</span>
                      <div className="text-left min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold">
                          Detected
                        </div>
                        <div className="text-emerald-200 text-[13px] font-medium truncate">
                          {engineStatus?.game_title}
                        </div>
                      </div>
                    </>
                  ) : engineStatus?.running ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-white/30 animate-pulse shrink-0" />
                      <span className="text-white/50 text-[12px]">
                        Watching for a game — nothing detected yet.
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="text-left min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold">
                          Engine offline
                        </div>
                        <div className="text-white/50 text-[12px]">
                          It doesn't start automatically yet — turn it on to try detection now.
                        </div>
                      </div>
                      <button
                        onClick={startEngine}
                        disabled={startingEngine}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer text-white disabled:opacity-50 disabled:cursor-default"
                        style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                      >
                        {startingEngine ? "Starting…" : "Start Engine"}
                      </button>
                    </>
                  )}
                </div>

                <p className="text-white/25 text-[11px] mb-5">
                  If it ever guesses wrong, fix it instantly from the Dashboard. Want it running
                  every launch? Turn on Auto-start Engine in Settings.
                </p>

                <button
                  onClick={() => setStep(5)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Continue
                </button>
              </>
            )}

            {/* ── Step 5: Exit behavior ───────────────────────────────── */}
            {step === 5 && (
              <>
                <div className="text-4xl mb-4">🚪</div>
                <h3 className="text-white font-bold text-lg mb-2">Closing the window</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  What should the ✕ button do? You can change this later in Settings.
                </p>

                <div className="flex flex-col gap-2.5 w-full mb-5">
                  <button
                    onClick={() => chooseExitBehavior(true)}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                      minimizeToTray
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-white/[0.03] border-white/10 hover:border-white/20"
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center"
                      style={{
                        borderColor: minimizeToTray ? "#9146FF" : "rgba(255,255,255,0.3)",
                      }}
                    >
                      {minimizeToTray && (
                        <span className="w-2 h-2 rounded-full" style={{ background: "#9146FF" }} />
                      )}
                    </span>
                    <span>
                      <span className="block text-white text-[13px] font-semibold">
                        Keep running in the tray
                      </span>
                      <span className="block text-white/40 text-[11px] mt-0.5">
                        StatusForge keeps updating your stream in the background — click the tray
                        icon to bring the window back.
                      </span>
                    </span>
                  </button>

                  <button
                    onClick={() => chooseExitBehavior(false)}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                      !minimizeToTray
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-white/[0.03] border-white/10 hover:border-white/20"
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center"
                      style={{
                        borderColor: !minimizeToTray ? "#9146FF" : "rgba(255,255,255,0.3)",
                      }}
                    >
                      {!minimizeToTray && (
                        <span className="w-2 h-2 rounded-full" style={{ background: "#9146FF" }} />
                      )}
                    </span>
                    <span>
                      <span className="block text-white text-[13px] font-semibold">
                        Quit completely
                      </span>
                      <span className="block text-white/40 text-[11px] mt-0.5">
                        Closing the window shuts StatusForge down — nothing runs until you open it
                        again.
                      </span>
                    </span>
                  </button>
                </div>

                <button
                  onClick={() => setStep(6)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Continue
                </button>
              </>
            )}

            {/* ── Step 6: Performance ─────────────────────────────────── */}
            {step === 6 && (
              <>
                <div className="text-4xl mb-4">⚡</div>
                <h3 className="text-white font-bold text-lg mb-2">Smooth or lightweight?</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  Controls how much GPU StatusForge uses for its own animations. You can change this
                  later in Settings.
                </p>

                <div className="flex flex-col gap-2.5 w-full mb-5">
                  <button
                    onClick={() => choosePerformance(true)}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                      hardwareAccel
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-white/[0.03] border-white/10 hover:border-white/20"
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center"
                      style={{
                        borderColor: hardwareAccel ? "#9146FF" : "rgba(255,255,255,0.3)",
                      }}
                    >
                      {hardwareAccel && (
                        <span className="w-2 h-2 rounded-full" style={{ background: "#9146FF" }} />
                      )}
                    </span>
                    <span>
                      <span className="block text-white text-[13px] font-semibold">
                        Smooth animations
                      </span>
                      <span className="block text-white/40 text-[11px] mt-0.5">
                        Uses your GPU to render the window. Best on most machines.
                      </span>
                    </span>
                  </button>

                  <button
                    onClick={() => choosePerformance(false)}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                      !hardwareAccel
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-white/[0.03] border-white/10 hover:border-white/20"
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center"
                      style={{
                        borderColor: !hardwareAccel ? "#9146FF" : "rgba(255,255,255,0.3)",
                      }}
                    >
                      {!hardwareAccel && (
                        <span className="w-2 h-2 rounded-full" style={{ background: "#9146FF" }} />
                      )}
                    </span>
                    <span>
                      <span className="block text-white text-[13px] font-semibold">
                        Best performance
                      </span>
                      <span className="block text-white/40 text-[11px] mt-0.5">
                        Turns off heavy CSS animations — lighter on CPU, useful while you're also
                        running a game and encoding a stream.
                      </span>
                    </span>
                  </button>
                </div>

                <button
                  onClick={() => setStep(7)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Continue
                </button>
              </>
            )}

            {/* ── Step 7: Done ────────────────────────────────────────── */}
            {step === 7 && (
              <>
                <div className="text-4xl mb-4">✅</div>
                <h3 className="text-white font-bold text-lg mb-2">You're all set</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-7 max-w-[320px] mx-auto">
                  Everything else — API keys, themes, notifications — lives in Settings whenever you
                  want it. Just start playing.
                </p>
                <button
                  onClick={onFinish}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Get Started
                </button>
              </>
            )}

            {!isLast && (
              <button
                onClick={onFinish}
                className="mt-4 text-[11px] text-white/25 hover:text-white/45 transition-colors cursor-pointer"
              >
                Skip setup guide
              </button>
            )}
          </div>
        </div>
      </div>

      {oauthOpen && (
        <OAuthConnectModal
          open={oauthOpen}
          onClose={() => setOauthOpen(false)}
          platform={oauthPlatform}
          connectUrl={PLATFORM_INFO[oauthPlatform].connectUrl}
          onSuccess={onOAuthSuccess}
        />
      )}
    </div>,
    document.body
  );
}
