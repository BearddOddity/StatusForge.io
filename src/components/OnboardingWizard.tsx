import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { ViewId, AppConfig, EngineStatus } from "@/types";
import { fetchConfig, saveConfig, fetchOverlayToken, tauriApi } from "@/hooks/useTauriApi";
import OAuthConnectModal from "@/components/OAuthConnectModal";

interface Props {
  onFinish: () => void;
  onNavigate: (view: ViewId) => void;
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
    redirectUri: "http://localhost:53735/oauth/callback/kick",
    clientIdKey: "kick_client",
    clientSecretKey: "kick_secret",
    tokenKey: "kick_token",
    refreshKey: "kick_refresh",
  },
};

const STEP_LABELS = ["Welcome", "Connect", "Overlay", "Detection", "Done"];

export default function OnboardingWizard({ onFinish, onNavigate }: Props) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [platform, setPlatform] = useState<Platform>("twitch");
  const [saving, setSaving] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [copiedRedirect, setCopiedRedirect] = useState(false);
  const [overlayToken, setOverlayToken] = useState("");
  const [overlayCopied, setOverlayCopied] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);

  // Live detection status, only while the user's actually looking at that
  // step — no point polling in the background for a step they've moved on
  // from.
  useEffect(() => {
    if (step !== 3) return;
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

  const info = PLATFORM_INFO[platform];
  const bc = config?.broadcaster;
  const isConnected = !!(bc && (bc[info.tokenKey] || bc[info.refreshKey]));
  const clientId = (bc?.[info.clientIdKey] as string) || "";
  const clientSecret = (bc?.[info.clientSecretKey] as string) || "";

  const setField = (key: string, value: string) => {
    setConfig((prev) =>
      prev ? { ...prev, broadcaster: { ...prev.broadcaster, [key]: value } } : prev
    );
  };

  const persistAndConnect = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveConfig(config);
    } finally {
      setSaving(false);
    }
    setOauthOpen(true);
  };

  const onOAuthSuccess = () => {
    fetchConfig().then(setConfig);
  };

  const copyRedirect = () => {
    navigator.clipboard?.writeText(info.redirectUri);
    setCopiedRedirect(true);
    setTimeout(() => setCopiedRedirect(false), 1500);
  };

  const copyOverlayUrl = () => {
    const url = `http://127.0.0.1:53735/forge-overlay/${overlayToken}/Horizontal_Left.html`;
    navigator.clipboard?.writeText(url);
    setOverlayCopied(true);
    setTimeout(() => setOverlayCopied(false), 1500);
  };

  const isLast = step === STEP_LABELS.length - 1;
  const detected = engineStatus?.is_playing && engineStatus.game_title;

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
                  Let's get you set up — three quick steps, each with a real thing to click, not
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

            {/* ── Step 1: Connect a platform ──────────────────────────── */}
            {step === 1 && (
              <>
                <div className="text-4xl mb-4">🔗</div>
                <h3 className="text-white font-bold text-lg mb-2">Connect Twitch or Kick</h3>
                <p className="text-white/50 text-[13px] leading-relaxed mb-5 max-w-[380px] mx-auto">
                  This is the one step that really matters — without it, StatusForge has nothing to
                  update.
                </p>

                <div className="flex w-full mb-4 rounded-lg bg-white/[0.04] border border-white/10 p-0.5">
                  {(["twitch", "kick"] as Platform[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPlatform(p)}
                      className={`flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-all cursor-pointer ${
                        platform === p
                          ? "bg-white/10 text-white"
                          : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      {PLATFORM_INFO[p].label}
                    </button>
                  ))}
                </div>

                {isConnected ? (
                  <div className="w-full text-left">
                    <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 mb-4">
                      <span className="text-emerald-400 text-base">✓</span>
                      <span className="text-emerald-300 text-[12px] font-medium">
                        {info.label} is connected
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="w-full text-left mb-4">
                    <div className="mb-3">
                      <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                        1. Register an app on {info.label}
                      </span>
                      <button
                        onClick={() => openUrl(info.devConsoleUrl).catch(() => {})}
                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold cursor-pointer border border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white transition-all"
                      >
                        Open {info.label} Developer Console ↗
                      </button>
                    </div>

                    <div className="mb-3">
                      <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                        2. Set its OAuth Redirect URL to
                      </span>
                      <button
                        onClick={copyRedirect}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 cursor-pointer hover:border-white/20 transition-all"
                      >
                        <code className="text-[10px] text-white/70 font-mono truncate">
                          {info.redirectUri}
                        </code>
                        <span className="text-[10px] text-white/40 shrink-0">
                          {copiedRedirect ? "Copied ✓" : "Copy"}
                        </span>
                      </button>
                    </div>

                    <div className="mb-1">
                      <span className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
                        3. Paste its Client ID and Secret
                      </span>
                      <div className="flex flex-col gap-2">
                        <input
                          value={clientId}
                          onChange={(e) => setField(info.clientIdKey, e.target.value)}
                          placeholder="Client ID"
                          className="input-glass"
                        />
                        <input
                          type="password"
                          value={clientSecret}
                          onChange={(e) => setField(info.clientSecretKey, e.target.value)}
                          placeholder="Client Secret"
                          className="input-glass"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {isConnected ? (
                    <button
                      onClick={() => setStep(2)}
                      className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                      style={{ background: info.gradient }}
                    >
                      Continue
                    </button>
                  ) : (
                    <button
                      onClick={persistAndConnect}
                      disabled={!clientId.trim() || !clientSecret.trim() || saving}
                      className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white disabled:opacity-40 disabled:cursor-default"
                      style={{ background: info.gradient }}
                    >
                      {saving ? "Saving…" : `Connect ${info.label}`}
                    </button>
                  )}
                  <button
                    onClick={() => setStep(2)}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                  >
                    {isConnected ? "Skip" : "I'll do this later"}
                  </button>
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
                  onClick={() => {
                    onNavigate("dashboard");
                  }}
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

            {/* ── Step 3: Live detection check ────────────────────────── */}
            {step === 3 && (
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
                  ) : (
                    <>
                      <span className="w-2 h-2 rounded-full bg-white/30 animate-pulse shrink-0" />
                      <span className="text-white/50 text-[12px]">
                        Watching for a game — nothing detected yet.
                      </span>
                    </>
                  )}
                </div>

                <p className="text-white/25 text-[11px] mb-5">
                  If it ever guesses wrong, fix it instantly from the Dashboard.
                </p>

                <button
                  onClick={() => setStep(4)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Continue
                </button>
              </>
            )}

            {/* ── Step 4: Done ────────────────────────────────────────── */}
            {step === 4 && (
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
          platform={platform}
          connectUrl={info.connectUrl}
          onSuccess={onOAuthSuccess}
        />
      )}
    </div>,
    document.body
  );
}
