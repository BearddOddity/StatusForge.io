import { useState, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { EngineStatus, ToastType, SystemStats, ViewId } from "@statusforge/types";
import {
  tauriApi,
  getSystemStats,
  fetchOverlayToken,
  fetchConfig,
  saveConfig,
} from "@statusforge/hooks/useTauriApi";
import { Card, Btn, FieldSection } from "@statusforge/components/ui";
import { Toggle } from "@statusforge/components/SettingsComponents";
import { resolveImageSrc } from "@statusforge/utils/imageSrc";
import { loadSystemPrefs, saveSystemPrefs } from "@statusforge/systemPrefs";

const idleCover = "/just%20chatting.png";
const offlineCover = "/offline.svg";

// width/height are each overlay's actual rendered size (from its own CSS),
// used to scale the live iframe preview down to fit the picker card without
// distorting it.
const overlays = [
  {
    id: "hl",
    label: "Horizontal Left",
    file: "Horizontal_Left.html",
    icon: "◀",
    width: 850,
    height: 480,
  },
  {
    id: "hr",
    label: "Horizontal Right",
    file: "Horizontal_Right.html",
    icon: "▶",
    width: 850,
    height: 480,
  },
  {
    id: "vt",
    label: "Vertical",
    file: "Vertical.html",
    icon: "▼",
    width: 360,
    height: 620,
  },
  {
    id: "lg",
    label: "Logo Only",
    file: "Logo.html",
    icon: "◆",
    width: 560,
    height: 280,
  },
  {
    id: "ib",
    label: "Info Box",
    file: "Info_Box.html",
    icon: "ℹ",
    width: 560,
    height: 200,
  },
  {
    id: "cc",
    label: "Compact Cover",
    file: "Compact_Cover.html",
    icon: "🎵",
    width: 620,
    height: 230,
  },
];

const platformDefs = [
  {
    key: "twitch" as const,
    name: "Twitch",
    icon: (
      <svg
        className="w-3.5 h-3.5 text-purple-400 shrink-0"
        viewBox="0 0 2400 2800"
        fill="currentColor"
      >
        <path d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600 V1300z" />
        <rect x="1700" y="550" width="200" height="600" />
        <rect x="1150" y="550" width="200" height="600" />
      </svg>
    ),
    dotColor: "bg-purple-400",
  },
  {
    key: "kick" as const,
    name: "Kick",
    icon: (
      <svg
        className="w-3.5 h-3.5 text-emerald-400 shrink-0"
        viewBox="0 0 453.9 510.6"
        fill="currentColor"
      >
        <path d="M0,0h170.2v113.5h56.7v-56.7h56.7V0h170.2v170.2h-56.7v56.7h-56.7v56.7h56.7v56.7h56.7v170.2h-170.2v-56.7h-56.7v-56.7h-56.7v113.5H0V0Z" />
      </svg>
    ),
    dotColor: "bg-emerald-400",
  },
  {
    key: "sbot" as const,
    name: "S.Bot",
    icon: (
      <svg
        className="w-3.5 h-3.5 text-amber-400 shrink-0"
        viewBox="100 50 360 525"
        fill="currentColor"
      >
        <path
          fill="currentColor"
          d="M290.653 55.563C290.55 55.662 290.448 55.763 290.346 55.864L135.331 210.88C124.658 221.552 124.658 238.882 135.331 249.555L135.369 249.593L135.516 249.741L290.663 404.888C295.986 410.212 302.966 412.88 309.95 412.893C316.967 412.906 323.989 410.238 329.338 404.888L329.379 404.846L329.393 404.833C329.393 404.833 359.206 375.02 369.615 364.611C371.568 362.658 371.568 359.492 369.615 357.539C362.257 350.181 345.37 333.294 338.011 325.936C336.059 323.983 332.893 323.983 330.94 325.936C327.327 329.549 321.617 335.259 317.071 339.805C315.196 341.68 312.652 342.734 310 342.734C307.348 342.734 304.805 341.68 302.929 339.805C283.19 320.066 227.408 264.283 203.947 240.822C198.09 234.965 198.089 225.47 203.944 219.611C224.007 199.54 267.71 155.818 292.276 131.242C302.037 121.476 317.866 121.473 327.631 131.234C352.245 155.837 396.073 199.646 416.178 219.742C418.992 222.555 420.573 226.37 420.573 230.349C420.574 234.328 418.993 238.144 416.18 240.957C411.009 246.128 405.135 252.003 401.485 255.652C399.532 257.605 399.532 260.771 401.485 262.723C408.843 270.082 425.73 286.969 433.089 294.327C435.042 296.28 438.207 296.28 440.16 294.327C451.279 283.209 484.802 249.686 484.802 249.686C495.474 239.013 495.474 221.683 484.802 211.011L465.464 191.673L465.464 191.674L329.341 55.55C324.003 50.213 317.002 47.545 310 47.546C303 47.546 296.001 50.215 290.665 55.55L290.653 55.563Z"
        />
        <path
          fill="currentColor"
          d="M302.929 280.195C306.834 276.29 313.166 276.29 317.071 280.195C336.764 299.888 392.321 355.445 415.728 378.852C421.585 384.71 421.585 394.207 415.728 400.065C395.644 420.149 351.878 463.914 327.288 488.504C317.525 498.267 301.696 498.267 291.933 488.504C267.461 464.033 224.024 420.595 204.033 400.605C198.175 394.747 198.175 385.249 204.033 379.391C209.231 374.193 215.146 368.278 218.814 364.611C220.766 362.658 220.766 359.492 218.814 357.54C211.455 350.181 194.568 333.294 187.21 325.936C185.257 323.983 182.091 323.983 180.139 325.936C169.023 337.052 135.516 370.559 135.516 370.559C135.426 370.648 135.338 370.738 135.248 370.83C124.742 381.514 124.798 398.719 135.415 409.336L290.274 564.195C300.947 574.868 318.276 574.868 328.949 564.195L348.286 544.858L348.286 544.857L465.009 428.133L465.147 428.271L484.484 408.934C495.157 398.261 495.157 380.931 484.484 370.259L348.675 234.449L348.675 234.449L329.338 215.111C318.665 204.439 301.336 204.439 290.663 215.111C290.663 215.111 260.804 244.971 250.385 255.389C248.432 257.342 248.432 260.508 250.385 262.46C257.743 269.819 274.63 286.706 281.989 294.064C283.942 296.017 287.107 296.017 289.06 294.064C292.673 290.451 298.384 284.741 302.929 280.195Z"
        />
      </svg>
    ),
    dotColor: "bg-amber-400",
  },
];

interface PlatformConnections {
  twitch: boolean;
  kick: boolean;
  sbot: boolean;
}

const disconnectedPlatforms: PlatformConnections = { twitch: false, kick: false, sbot: false };

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    // Overlay URLs already saved by a user before the widget->overlay
    // rename still use the old segment name — recognize both.
    const routeIdx =
      parts.indexOf("forge-overlay") >= 0
        ? parts.indexOf("forge-overlay")
        : parts.indexOf("forge-widget");
    const tokenIdx = routeIdx + 1;
    if (routeIdx >= 0 && parts[tokenIdx]) {
      const raw = parts[tokenIdx];
      const masked = raw.length > 4 ? "•".repeat(raw.length - 4) + raw.slice(-4) : "••••";
      parts[tokenIdx] = masked;
    }
    return "/" + parts.slice(routeIdx + 1).join("/");
  } catch {
    return url;
  }
}

// ─── Dashboard View ───────────────────────────────────────────────────────────

export default function DashboardView({
  engineStatus,
  wsConnected,
  toast,
  onNavigate,
  onRefresh,
  openOverlayPicker,
  onOverlayPickerOpened,
  onStartOnboarding,
}: {
  engineStatus: EngineStatus;
  wsConnected: boolean;
  toast: (msg: string, type?: ToastType) => void;
  onNavigate: (view: ViewId) => void;
  onRefresh: () => Promise<void>;
  // Lets a caller outside this view (the onboarding wizard's "Browse other
  // overlay styles" link) open the picker modal on arrival instead of
  // silently switching views with no way to actually reach it.
  openOverlayPicker?: boolean;
  onOverlayPickerOpened?: () => void;
  onStartOnboarding: () => void;
}) {
  const [setupHelpDismissed, setSetupHelpDismissed] = useState(
    () => loadSystemPrefs().setupBannerDismissed
  );
  const dismissSetupHelp = () => {
    setSetupHelpDismissed(true);
    saveSystemPrefs({ ...loadSystemPrefs(), setupBannerDismissed: true });
  };
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideText, setOverrideText] = useState("");
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  // The engine's running flag flips instantly on the backend, but the
  // Dashboard otherwise only learns about it from the next scheduled status
  // poll (up to 10s away) -- calling onRefresh() right after the toggle
  // closes that gap, and this local flag disables the button in the
  // meantime so a slow click can't fire the command twice.
  const [engineToggling, setEngineToggling] = useState(false);

  const submitOverride = async () => {
    const name = overrideText.trim();
    if (!name) return;
    setOverrideSubmitting(true);
    try {
      const r = await tauriApi("override_game", { title: name });
      toast(
        typeof r === "string" ? r : "Failed to override",
        typeof r === "string" ? "success" : "error"
      );
      setOverrideOpen(false);
      setOverrideText("");
    } finally {
      setOverrideSubmitting(false);
    }
  };

  // Post-broadcast feedback: "Detected X — correct?" after each automatic
  // detection. A "No" correction is logged (per-method accuracy stats),
  // teaches the alias system, and re-broadcasts the right game.
  const [feedback, setFeedback] = useState<{ title: string; method: string } | null>(null);
  const [feedbackCorrecting, setFeedbackCorrecting] = useState(false);
  const [feedbackActual, setFeedbackActual] = useState("");

  useEffect(() => {
    const subs = [
      listen<{ title: string; platform?: string }>("game-detected", (e) => {
        const title = e.payload?.title ?? "";
        const method = e.payload?.platform ?? "";
        // Manual overrides are the user's own word — nothing to confirm.
        if (!title || method === "Manual Override") {
          setFeedback(null);
          return;
        }
        setFeedback({ title, method });
        setFeedbackCorrecting(false);
        setFeedbackActual("");
      }),
      listen("game-cleared", () => setFeedback(null)),
    ];
    return () => {
      subs.forEach((s) => s.then((u) => u()).catch(() => {}));
    };
  }, []);

  const confirmDetection = async () => {
    if (!feedback) return;
    try {
      await tauriApi("log_detection_feedback", {
        detectedTitle: feedback.title,
        method: feedback.method,
        actualTitle: null,
      });
    } catch {
      // Tally failure isn't worth interrupting the user over.
    }
    setFeedback(null);
  };

  const submitCorrection = async () => {
    if (!feedback) return;
    const actual = feedbackActual.trim();
    if (!actual) return;
    try {
      const r = await tauriApi("log_detection_feedback", {
        detectedTitle: feedback.title,
        method: feedback.method,
        actualTitle: actual,
      });
      toast(typeof r === "string" ? r : "Correction saved", "success");
      await tauriApi("override_game", { title: actual });
    } catch (e) {
      toast(`Failed to save correction: ${e}`, "error");
    }
    setFeedback(null);
  };

  const [overlayUrls, setOverlayUrls] = useState<{ id: string; url: string; label: string }[]>([]);
  const [overlayIdCounter, setOverlayIdCounter] = useState(0);
  const [overlayPickerOpen, setOverlayPickerOpen] = useState(false);
  const [overlayIndex, setOverlayIndex] = useState(0);
  const [overlayViewMode, setOverlayViewMode] = useState<"grid" | "carousel">("grid");
  const overlayPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openOverlayPicker) {
      setOverlayPickerOpen(true);
      onOverlayPickerOpened?.();
    }
  }, [openOverlayPicker, onOverlayPickerOpened]);

  const [overlayToken, setOverlayToken] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchOverlayToken().then((t) => {
      if (!cancelled) setOverlayToken(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Platform Connections: real config/keychain state, not the widget WS link.
  // "Connected" means the stored Twitch/Kick token still actually works, not
  // just that one is saved — a token can be revoked/expired without
  // StatusForge knowing until it's used, so `check_platform_live_status`
  // makes a real (read-only) validation call on every refresh.
  const [platforms, setPlatforms] = useState<PlatformConnections>(disconnectedPlatforms);
  // Set once check_platform_live_status has tried a silent token refresh and
  // it genuinely failed (refresh token itself dead/revoked, not just an
  // expired access token) — the signal that a manual reconnect is actually
  // needed, distinct from a transient "Offline".
  const [needsReauth, setNeedsReauth] = useState({ twitch: false, kick: false });
  const [blipyPaired, setBlipyPaired] = useState<{ hostname: string } | null>(null);
  const [platformPushEnabled, setPlatformPushEnabled] = useState(true);
  const togglePlatformPush = async () => {
    const config = await fetchConfig();
    if (!config) return;
    const next = !config.engine_settings.platform_push_enabled;
    setPlatformPushEnabled(next);
    await saveConfig({
      ...config,
      engine_settings: { ...config.engine_settings, platform_push_enabled: next },
    });
    // Turning off leaves the last-pushed category alone (no revert). Turning
    // back on shouldn't wait for the player to switch games again — pick up
    // whatever's already in progress right away.
    if (next) await tauriApi("refresh_platform_push");
  };
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [config, hub, live] = await Promise.all([
        tauriApi("export_config"),
        tauriApi("hub_get_status"),
        tauriApi("check_platform_live_status"),
      ]);
      if (cancelled) return;
      if (config && typeof config === "object" && "engine_settings" in config) {
        setPlatformPushEnabled(
          (config as { engine_settings: { platform_push_enabled: boolean } }).engine_settings
            .platform_push_enabled
        );
      }
      // check_platform_live_status already accounts for tokens stored in
      // Config.json OR the OS keychain (auth::load_config_at backfills from
      // whichever one has it) and does a real live validation call — no
      // need to separately gate on get_all_keychain_tokens here too. That
      // extra gate used to require the token specifically be in the OS
      // keychain, which silently showed "Offline" for anyone who hadn't
      // migrated tokens there even though push/detection worked fine.
      // sbot is a TCP reachability check against the configured Streamer.bot
      // port, not a push validation — StatusForge doesn't push to it
      // directly in this routing mode (see check_platform_live_status).
      const liveStatus =
        live && typeof live === "object" && !("error" in live)
          ? (live as {
              twitch: boolean;
              twitch_needs_reauth: boolean;
              kick: boolean;
              kick_needs_reauth: boolean;
              sbot: boolean;
            })
          : {
              twitch: false,
              twitch_needs_reauth: false,
              kick: false,
              kick_needs_reauth: false,
              sbot: false,
            };
      setPlatforms({
        twitch: liveStatus.twitch,
        kick: liveStatus.kick,
        sbot: liveStatus.sbot,
      });
      setNeedsReauth({
        twitch: liveStatus.twitch_needs_reauth,
        kick: liveStatus.kick_needs_reauth,
      });
      const paired =
        hub && typeof hub === "object" && "paired_blipy" in hub
          ? (hub as { paired_blipy: { hostname: string } | null }).paired_blipy
          : null;
      setBlipyPaired(paired);
    };
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // System Performance: real CPU/memory of the StatusForge process.
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const s = await getSystemStats();
      if (!cancelled) setStats(s);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const addOverlayUrl = (file: string, label: string) => {
    if (!overlayToken) {
      toast("Overlay token not loaded yet — try again in a moment", "error");
      return;
    }
    const url = `http://127.0.0.1:53735/forge-overlay/${overlayToken}/${file}`;
    const id = `overlay-${overlayIdCounter}`;
    setOverlayUrls((prev) => [...prev, { id, url, label }]);
    setOverlayIdCounter((c) => c + 1);
    navigator.clipboard?.writeText(url);
    toast("Overlay URL copied to clipboard", "success");
  };

  const removeOverlayUrl = (id: string) => {
    setOverlayUrls((prev) => {
      const filtered = prev.filter((o) => o.id !== id);
      if (filtered.length === 0) {
        setOverlayIndex(0);
      }
      return filtered;
    });
    toast("Overlay removed", "info");
  };

  const isPlaying = engineStatus.is_playing;
  // While idle (engine running, nothing detected), the backend resolves
  // engineStatus.cover_url to the idle category's own Library entry (e.g.
  // "Just Chatting") when one has a custom cover set — falls back to the
  // built-in placeholder otherwise. Offline always wins regardless.
  const placeholderCover = engineStatus.running
    ? resolveImageSrc(engineStatus.cover_url) || idleCover
    : offlineCover;
  const title = isPlaying
    ? engineStatus.game_title
    : engineStatus.running
      ? "Just Chatting"
      : "Offline";

  return (
    <div>
      {/* Header */}
      <h2 className="text-2xl font-bold text-white tracking-tight mb-5">Dashboard</h2>

      {!setupHelpDismissed && (
        <div className="card-glass flex items-center justify-between gap-4 px-5 py-3 mb-5 border-purple-500/20 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-lg shrink-0">🧭</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white/85 truncate">
                Struggling to get set up?
              </div>
              <div className="text-[11px] text-white/40">
                Walk through connecting platforms, overlays, and detection again — step by step.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={dismissSetupHelp}
              className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer bg-transparent border-none px-2 py-1"
            >
              Dismiss
            </button>
            <Btn variant="success" onClick={onStartOnboarding}>
              Start Setup Guide
            </Btn>
          </div>
        </div>
      )}

      {/* Now Playing */}
      <Card className="overflow-hidden mb-5">
        <div className="flex gap-5 items-center">
          <div className="shrink-0 w-[140px] h-[180px] rounded-2xl overflow-hidden bg-black/30 border border-white/10 relative shadow-lg shadow-black/30">
            {isPlaying && (
              <div className="absolute inset-0 rounded-2xl border border-purple-500/30 pointer-events-none z-10" />
            )}
            <div
              className="w-full h-full"
              style={{
                animation: isPlaying
                  ? "var(--user-cover-breathe, cover-breathe 8s ease-in-out infinite)"
                  : "none",
              }}
            >
              <img
                src={
                  isPlaying
                    ? resolveImageSrc(engineStatus.cover_url) || placeholderCover
                    : placeholderCover
                }
                alt={title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (!img.dataset.fallback) {
                    img.dataset.fallback = "1";
                    img.src = placeholderCover;
                  } else if (!img.dataset.placeholder) {
                    img.dataset.placeholder = "1";
                    img.src =
                      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'%3E%3Crect fill='%23111' width='300' height='400'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%23333' font-size='48'%3E🎮%3C/text%3E%3C/svg%3E";
                  }
                }}
              />
            </div>
            {isPlaying && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ animation: "var(--user-cover-glint, glint-slide 8s linear infinite)" }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-xl leading-tight truncate text-white">{title}</h3>
            <div className="flex items-center gap-2 mt-3">
              {engineStatus.running ? (
                <Btn
                  variant="danger"
                  disabled={engineToggling}
                  onClick={async () => {
                    setEngineToggling(true);
                    const r = await tauriApi("stop_engine");
                    toast(
                      typeof r === "string" ? r : "Failed",
                      typeof r === "string" ? "success" : "error"
                    );
                    await onRefresh();
                    setEngineToggling(false);
                  }}
                >
                  {engineToggling ? "Stopping…" : "⏹ Stop Engine"}
                </Btn>
              ) : (
                <Btn
                  disabled={engineToggling}
                  onClick={async () => {
                    setEngineToggling(true);
                    const r = await tauriApi("start_engine");
                    toast(
                      typeof r === "string" ? r : "Failed",
                      typeof r === "string" ? "success" : "error"
                    );
                    await onRefresh();
                    setEngineToggling(false);
                  }}
                >
                  {engineToggling ? "Starting…" : "Start Engine"}
                </Btn>
              )}
              {isPlaying && engineStatus.game_title && (
                <Btn
                  variant="ghost"
                  onClick={async () => {
                    const r = await tauriApi("exile_app", { game: engineStatus.game_title });
                    toast(
                      typeof r === "string" ? r : "Failed",
                      typeof r === "string" ? "success" : "error"
                    );
                  }}
                >
                  🚫 Exile to Apps
                </Btn>
              )}
              <Btn variant="ghost" onClick={() => setOverrideOpen((o) => !o)}>
                🎮 Override Game
              </Btn>
            </div>
            {overrideOpen && (
              <div className="flex items-center gap-2 mt-3">
                <input
                  autoFocus
                  type="text"
                  value={overrideText}
                  onChange={(e) => setOverrideText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitOverride();
                    if (e.key === "Escape") setOverrideOpen(false);
                  }}
                  placeholder="Enter game name..."
                  className="flex-1 min-w-0 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/85 placeholder:text-white/25 focus:outline-none focus:border-purple-500/40"
                />
                <Btn onClick={submitOverride} disabled={overrideSubmitting || !overrideText.trim()}>
                  Broadcast
                </Btn>
                <Btn variant="ghost" onClick={() => setOverrideOpen(false)}>
                  Cancel
                </Btn>
              </div>
            )}
            {feedback && isPlaying && (
              <div className="flex items-center gap-2 mt-3">
                {!feedbackCorrecting ? (
                  <>
                    <span className="text-[11px] text-white/45 truncate">
                      Detected “{feedback.title}” — is that right?
                    </span>
                    <Btn variant="success" onClick={confirmDetection}>
                      Yes
                    </Btn>
                    <Btn variant="ghost" onClick={() => setFeedbackCorrecting(true)}>
                      No
                    </Btn>
                  </>
                ) : (
                  <>
                    <input
                      autoFocus
                      type="text"
                      value={feedbackActual}
                      onChange={(e) => setFeedbackActual(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitCorrection();
                        if (e.key === "Escape") setFeedback(null);
                      }}
                      placeholder="What game is it actually?"
                      className="flex-1 min-w-0 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/85 placeholder:text-white/25 focus:outline-none focus:border-purple-500/40"
                    />
                    <Btn onClick={submitCorrection} disabled={!feedbackActual.trim()}>
                      Fix &amp; Broadcast
                    </Btn>
                    <Btn variant="ghost" onClick={() => setFeedback(null)}>
                      Dismiss
                    </Btn>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Status + Overlay Row */}
      <Card className="mb-5">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr] gap-5 items-start">
          {/* Platform Connections (left) */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] uppercase tracking-wider text-white/40">
                Platform Connections
              </p>
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-green-400" : "bg-white/20"}`}
                  style={{
                    animation: wsConnected
                      ? "var(--user-status-pulse, ping 2s cubic-bezier(0, 0, 0.2, 1) infinite)"
                      : "none",
                  }}
                />
                <span
                  className={`text-[10px] font-mono ${wsConnected ? "text-green-400/60" : "text-white/25"}`}
                >
                  {wsConnected ? "LIVE" : "POLLING"}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {platformDefs.map((p) => {
                const connected = platforms[p.key];
                const reauth = (p.key === "twitch" || p.key === "kick") && needsReauth[p.key];
                return (
                  <div key={p.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {p.icon}
                      <span className="text-xs font-medium text-white/70">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${connected ? p.dotColor : reauth ? "bg-amber-400" : "bg-white/20"}`}
                        style={{
                          animation:
                            connected || reauth
                              ? "var(--user-status-pulse, pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite)"
                              : "none",
                        }}
                      />
                      {reauth ? (
                        <button
                          onClick={() => {
                            onNavigate("settings");
                            toast(
                              `${p.name} needs to be reconnected — open API & Routing to sign in again.`,
                              "info"
                            );
                          }}
                          className="text-[10px] font-semibold text-amber-400/80 hover:text-amber-400 transition-colors cursor-pointer bg-transparent border-none p-0"
                          title={`${p.name}'s connection expired — click to reconnect`}
                        >
                          Reconnect
                        </button>
                      ) : (
                        <span
                          className={`text-[10px] font-medium ${connected ? "text-white/50" : "text-white/25"}`}
                        >
                          {connected ? "Connected" : "Offline"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Platform Detection quick toggle */}
            <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
              <span className="text-xs font-medium text-white/70">Platform Detection</span>
              <Toggle on={platformPushEnabled} onToggle={togglePlatformPush} />
            </div>
            {/* Blipy Pulse */}
            <div className="mt-3 pt-3 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${blipyPaired ? "bg-cyan-400/60" : "bg-white/10"}`}
                      style={{
                        animation: blipyPaired
                          ? "var(--user-status-pulse, ping 2s cubic-bezier(0, 0, 0.2, 1) infinite)"
                          : "none",
                      }}
                    />
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${blipyPaired ? "bg-cyan-400" : "bg-white/20"}`}
                    />
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider text-white/40">
                    {blipyPaired ? `Blipy · ${blipyPaired.hostname}` : "Blipy"}
                  </span>
                </div>
                <span
                  className={`text-[10px] font-mono ${blipyPaired ? "text-cyan-400/60" : "text-white/20"}`}
                >
                  {blipyPaired ? "SYNCED" : "STANDBY"}
                </span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="hidden lg:block w-px self-stretch bg-white/10" />

          {/* System Performance (center) — live CPU/memory of this process */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
                System Performance
              </p>
              <span className="text-[10px] text-white/25 font-mono">{stats ? "Live" : "—"}</span>
            </div>
            <div className="flex flex-col gap-2">
              {[
                {
                  label: "CPU",
                  value: stats ? `${stats.cpu_percent.toFixed(0)}%` : "—",
                  width: `${Math.min(100, stats?.cpu_percent ?? 0)}%`,
                  color: "from-purple-500 to-purple-400",
                  textColor: "text-purple-400/80",
                },
                {
                  label: "Memory",
                  value: stats ? `${stats.memory_mb} MB` : "—",
                  // Scaled against a 1 GB reference bar — StatusForge itself
                  // should sit well under that.
                  width: `${Math.min(100, ((stats?.memory_mb ?? 0) / 1024) * 100)}%`,
                  color: "from-emerald-500 to-emerald-400",
                  textColor: "text-emerald-400/80",
                },
              ].map((m) => (
                <div key={m.label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/30 uppercase tracking-wider">
                      {m.label}
                    </span>
                    <span className={`text-[11px] font-semibold ${m.textColor} font-mono`}>
                      {m.value}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${stats ? `bg-gradient-to-r ${m.color}` : "bg-white/5"}`}
                      style={{ width: stats ? m.width : "0%" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="hidden lg:block w-px self-stretch bg-white/10" />

          {/* Overlay Generator (right) */}
          <div>
            {overlayUrls.length === 0 && (
              <div className="px-3 py-2 bg-black/20 border border-white/5 rounded-lg flex items-center gap-2 mb-3">
                <span className="text-[11px] font-mono text-white/30 break-all flex-1 min-w-0">
                  /••••••••••••••••kN2x/Horizontal_Left.html
                </span>
                <span className="shrink-0 p-1.5 rounded-md bg-white/[0.03] border border-white/5 text-white/15 cursor-not-allowed">
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
                </span>
              </div>
            )}
            {overlayUrls.map((o) => (
              <div
                key={o.id}
                className="px-3 py-2 bg-black/20 border border-white/5 rounded-lg flex items-center gap-2 mb-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium text-white/40 mb-0.5">{o.label}</p>
                  <p className="text-[11px] font-mono text-white/50 break-all">{maskUrl(o.url)}</p>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(o.url);
                    toast("Overlay URL copied to clipboard", "success");
                  }}
                  className="shrink-0 p-1.5 rounded-md bg-white/[0.06] border border-white/10 text-white/40 hover:text-white/70 hover:bg-white/[0.1] transition-all cursor-pointer"
                  title="Copy full URL"
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
                  onClick={() => removeOverlayUrl(o.id)}
                  className="shrink-0 p-1.5 rounded-md bg-white/[0.03] border border-white/10 text-white/25 hover:text-red-400/70 hover:bg-red-500/10 hover:border-red-500/20 transition-all cursor-pointer"
                  title="Remove overlay"
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
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
            <div className="flex items-center justify-center mt-1">
              <Btn variant="ghost" onClick={() => setOverlayPickerOpen(true)}>
                Browse Overlays
              </Btn>
            </div>
          </div>
        </div>
      </Card>

      {/* Overlay Picker Modal */}
      {overlayPickerOpen && (
        <div className="modal-backdrop" onClick={() => setOverlayPickerOpen(false)}>
          <div
            ref={overlayPickerRef}
            className="modal-panel w-[92vw] max-w-[900px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between">
              <p className="text-white font-semibold text-sm">Select Overlay</p>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-black/30 border border-white/10 rounded-lg p-0.5">
                  <button
                    onClick={() => setOverlayViewMode("grid")}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                      overlayViewMode === "grid"
                        ? "bg-purple-500/25 text-purple-200"
                        : "text-white/40 hover:text-white/70"
                    }`}
                  >
                    ▦ Grid
                  </button>
                  <button
                    onClick={() => setOverlayViewMode("carousel")}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                      overlayViewMode === "carousel"
                        ? "bg-purple-500/25 text-purple-200"
                        : "text-white/40 hover:text-white/70"
                    }`}
                  >
                    ⇄ Carousel
                  </button>
                </div>
                <button
                  onClick={() => setOverlayPickerOpen(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-all cursor-pointer text-xs"
                >
                  ✕
                </button>
              </div>
            </div>

            {overlayViewMode === "grid" ? (
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {overlays.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => {
                      addOverlayUrl(o.file, o.label);
                      setOverlayPickerOpen(false);
                    }}
                    className="group text-left cursor-pointer"
                  >
                    <div className="relative w-full h-[220px] rounded-2xl overflow-hidden border border-white/10 bg-[#0a0a12] transition-all duration-200 group-hover:border-purple-500/50 group-hover:shadow-lg group-hover:shadow-purple-500/15">
                      {overlayToken ? (
                        <iframe
                          // ?preview=1 tells the overlay to stay fully visible
                          // regardless of the real fade timer / idle state —
                          // this is a style picker, not a live stream check.
                          src={`http://127.0.0.1:53735/forge-overlay/${overlayToken}/${o.file}?preview=1`}
                          title={`${o.label} preview`}
                          tabIndex={-1}
                          className="pointer-events-none absolute top-1/2 left-1/2 border-0"
                          style={{
                            width: `${o.width}px`,
                            height: `${o.height}px`,
                            transform: `translate(-50%, -50%) scale(${Math.min(400 / o.width, 220 / o.height)})`,
                            transformOrigin: "center",
                          }}
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-[#1a1a2e] to-[#16213e] flex items-center justify-center">
                          <div className="text-3xl">{o.icon}</div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between mt-2 px-1">
                      <span className="text-[13px] font-medium text-white/80 group-hover:text-white transition-colors">
                        {o.label}
                      </span>
                      <span className="text-[11px] text-purple-300/0 group-hover:text-purple-300/90 transition-colors">
                        Use →
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-5">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() =>
                      setOverlayIndex((p) => (p - 1 + overlays.length) % overlays.length)
                    }
                    className="shrink-0 w-10 h-10 flex items-center justify-center bg-black/50 border border-white/10 rounded-full text-white/60 hover:text-white transition-all cursor-pointer text-base"
                  >
                    ‹
                  </button>
                  <div className="flex-1 flex justify-center relative h-[240px]">
                    {overlays.map((o, i) => {
                      const a = i === overlayIndex;
                      return (
                        <div
                          key={o.id}
                          className={`shrink-0 w-[380px] transition-all duration-300 ${a ? "scale-100 opacity-100" : "scale-75 opacity-0 pointer-events-none absolute"}`}
                        >
                          <div
                            className={`relative w-full h-[220px] rounded-2xl overflow-hidden border bg-[#0a0a12] transition-all duration-300 ${a ? "border-purple-500/50 shadow-lg shadow-purple-500/15" : "border-white/10"}`}
                          >
                            {overlayToken ? (
                              <iframe
                                key={o.id}
                                src={`http://127.0.0.1:53735/forge-overlay/${overlayToken}/${o.file}?preview=1`}
                                title={`${o.label} preview`}
                                tabIndex={-1}
                                className="pointer-events-none absolute top-1/2 left-1/2 border-0"
                                style={{
                                  width: `${o.width}px`,
                                  height: `${o.height}px`,
                                  transform: `translate(-50%, -50%) scale(${Math.min(380 / o.width, 220 / o.height)})`,
                                  transformOrigin: "center",
                                }}
                              />
                            ) : (
                              <div className="w-full h-full bg-gradient-to-br from-[#1a1a2e] to-[#16213e] flex items-center justify-center">
                                <div className="text-center px-4">
                                  <div className="text-2xl mb-1.5">{o.icon}</div>
                                  <span className="text-white/50 text-xs font-medium">
                                    {o.label}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="text-center mt-2">
                            <span
                              className={`text-[13px] font-medium ${a ? "text-white/90" : "text-white/30"}`}
                            >
                              {o.label}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setOverlayIndex((p) => (p + 1) % overlays.length)}
                    className="shrink-0 w-10 h-10 flex items-center justify-center bg-black/50 border border-white/10 rounded-full text-white/60 hover:text-white transition-all cursor-pointer text-base"
                  >
                    ›
                  </button>
                </div>
                <div className="flex justify-center gap-1.5 mt-3">
                  {overlays.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setOverlayIndex(i)}
                      className={`h-1.5 rounded-full transition-all cursor-pointer ${i === overlayIndex ? "bg-purple-500 w-4" : "bg-white/20 w-1.5 hover:bg-white/40"}`}
                    />
                  ))}
                </div>
                <div className="flex justify-center mt-4">
                  <Btn
                    onClick={() => {
                      addOverlayUrl(overlays[overlayIndex]!.file, overlays[overlayIndex]!.label);
                      setOverlayPickerOpen(false);
                    }}
                  >
                    Use {overlays[overlayIndex]!.label}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metadata */}
      <FieldSection title="Metadata" defaultOpen={false} icon="📋">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(
            [
              ["Genre", engineStatus.genre],
              ["Developer", engineStatus.developer],
              ["Publisher", engineStatus.publisher],
              ["Release", engineStatus.release_date],
            ] as const
          ).map(([l, v]) => (
            <div
              key={l}
              className="bg-white/[0.02] border border-white/[0.06] rounded-xl px-3.5 py-2.5 shadow-sm"
            >
              <p className="text-[10px] uppercase tracking-wider text-white/30 font-semibold">
                {l}
              </p>
              <p className="text-xs font-medium text-white/80 truncate mt-0.5">{v || "—"}</p>
            </div>
          ))}
        </div>
      </FieldSection>
    </div>
  );
}
