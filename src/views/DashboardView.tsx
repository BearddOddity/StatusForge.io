import { useState, useRef, useEffect } from "react";
import type { EngineStatus, ToastType, SystemStats } from "@/types";
import { tauriApi, getKeychainStatus, getSystemStats, fetchWidgetToken } from "@/hooks/useTauriApi";
import { Card, Btn, FieldSection } from "@/components/ui";

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
    const tokenIdx = parts.indexOf("forge-widget") + 1;
    if (tokenIdx > 0 && parts[tokenIdx]) {
      const raw = parts[tokenIdx];
      const masked = raw.length > 4 ? "•".repeat(raw.length - 4) + raw.slice(-4) : "••••";
      parts[tokenIdx] = masked;
    }
    return "/" + parts.slice(parts.indexOf("forge-widget") + 1).join("/");
  } catch {
    return url;
  }
}

// ─── Dashboard View ───────────────────────────────────────────────────────────

export default function DashboardView({
  engineStatus,
  wsConnected,
  toast,
}: {
  engineStatus: EngineStatus;
  wsConnected: boolean;
  toast: (msg: string, type?: ToastType) => void;
}) {
  const [overlayUrls, setOverlayUrls] = useState<{ id: string; url: string; label: string }[]>([]);
  const [overlayIdCounter, setOverlayIdCounter] = useState(0);
  const [layout, setLayout] = useState("Horizontal_Left.html");
  const [overlayPickerOpen, setOverlayPickerOpen] = useState(false);
  const [overlayIndex, setOverlayIndex] = useState(0);
  const overlayPickerRef = useRef<HTMLDivElement>(null);

  const [widgetToken, setWidgetToken] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchWidgetToken().then((t) => {
      if (!cancelled) setWidgetToken(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Platform Connections: real config/keychain state, not the widget WS link.
  const [platforms, setPlatforms] = useState<PlatformConnections>(disconnectedPlatforms);
  const [sparkPaired, setSparkPaired] = useState<{ hostname: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [keychain, config, hub] = await Promise.all([
        getKeychainStatus(),
        tauriApi("export_config"),
        tauriApi("hub_get_status"),
      ]);
      if (cancelled) return;
      const routingMode =
        config && typeof config === "object" && "broadcaster" in config
          ? (config as { broadcaster: { routing_mode: string } }).broadcaster.routing_mode
          : "";
      setPlatforms({
        twitch: keychain.stored.includes("twitch_token"),
        kick: keychain.stored.includes("kick_token"),
        sbot: routingMode === "streamer_bot",
      });
      const paired =
        hub && typeof hub === "object" && "paired_spark" in hub
          ? (hub as { paired_spark: { hostname: string } | null }).paired_spark
          : null;
      setSparkPaired(paired);
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
    if (!widgetToken) {
      toast("Overlay token not loaded yet — try again in a moment", "error");
      return;
    }
    const url = `http://127.0.0.1:53735/forge-widget/${widgetToken}/${file}`;
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
        setLayout("Horizontal_Left.html");
        setOverlayIndex(0);
      }
      return filtered;
    });
    toast("Overlay removed", "info");
  };

  const isPlaying = engineStatus.is_playing;
  const placeholderCover = engineStatus.running ? idleCover : offlineCover;
  const title = isPlaying
    ? engineStatus.game_title
    : engineStatus.running
      ? "Just Chatting"
      : "Offline";

  return (
    <div>
      {/* Header */}
      <h2 className="text-2xl font-bold text-white tracking-tight mb-5">Status Room</h2>

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
                src={isPlaying ? engineStatus.cover_url || placeholderCover : placeholderCover}
                alt={title}
                className="w-full h-full object-cover"
                crossOrigin="anonymous"
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
                  onClick={async () => {
                    const r = await tauriApi("stop_engine");
                    toast(
                      typeof r === "string" ? r : "Failed",
                      typeof r === "string" ? "success" : "error"
                    );
                  }}
                >
                  ⏹ Stop Engine
                </Btn>
              ) : (
                <Btn
                  onClick={async () => {
                    const r = await tauriApi("start_engine");
                    toast(
                      typeof r === "string" ? r : "Failed",
                      typeof r === "string" ? "success" : "error"
                    );
                  }}
                >
                  Start Engine
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
            </div>
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
                return (
                  <div key={p.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {p.icon}
                      <span className="text-xs font-medium text-white/70">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${connected ? p.dotColor : "bg-white/20"}`}
                        style={{
                          animation: connected
                            ? "var(--user-status-pulse, pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite)"
                            : "none",
                        }}
                      />
                      <span
                        className={`text-[10px] font-medium ${connected ? "text-white/50" : "text-white/25"}`}
                      >
                        {connected ? "Connected" : "Offline"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Spark Pulse */}
            <div className="mt-3 pt-3 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${sparkPaired ? "bg-cyan-400/60" : "bg-white/10"}`}
                      style={{
                        animation: sparkPaired
                          ? "var(--user-status-pulse, ping 2s cubic-bezier(0, 0, 0.2, 1) infinite)"
                          : "none",
                      }}
                    />
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${sparkPaired ? "bg-cyan-400" : "bg-white/20"}`}
                    />
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider text-white/40">
                    {sparkPaired ? `SPARK · ${sparkPaired.hostname}` : "SPARK"}
                  </span>
                </div>
                <span
                  className={`text-[10px] font-mono ${sparkPaired ? "text-cyan-400/60" : "text-white/20"}`}
                >
                  {sparkPaired ? "SYNCED" : "STANDBY"}
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
            className="modal-panel w-[90vw] max-w-[700px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between">
              <p className="text-white font-semibold text-sm">Select Overlay</p>
              <button
                onClick={() => setOverlayPickerOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-all cursor-pointer text-xs"
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-3">
                <button
                  onClick={() =>
                    setOverlayIndex((p) => (p - 1 + overlays.length) % overlays.length)
                  }
                  className="shrink-0 w-9 h-9 flex items-center justify-center bg-black/50 border border-white/10 rounded-full text-white/60 hover:text-white transition-all cursor-pointer text-sm"
                >
                  ‹
                </button>
                <div className="flex-1 flex justify-center">
                  {overlays.map((o, i) => {
                    const a = i === overlayIndex;
                    return (
                      <div
                        key={o.id}
                        className={`shrink-0 w-[260px] transition-all duration-300 ${a ? "scale-100 opacity-100" : "scale-75 opacity-30 pointer-events-none absolute"}`}
                      >
                        <div
                          className={`relative w-full h-[150px] rounded-xl overflow-hidden border bg-[#0a0a12] transition-all duration-300 ${a ? "border-purple-500/50 shadow-lg shadow-purple-500/15" : "border-white/10"}`}
                        >
                          {widgetToken ? (
                            <iframe
                              key={o.id}
                              src={`http://127.0.0.1:53735/forge-widget/${widgetToken}/${o.file}`}
                              title={`${o.label} preview`}
                              tabIndex={-1}
                              className="pointer-events-none absolute top-0 left-0 border-0"
                              style={{
                                width: `${o.width}px`,
                                height: `${o.height}px`,
                                transform: `scale(${260 / o.width})`,
                                transformOrigin: "top left",
                              }}
                            />
                          ) : (
                            <div className="w-full h-full bg-gradient-to-br from-[#1a1a2e] to-[#16213e] flex items-center justify-center">
                              <div className="text-center px-4">
                                <div className="text-xl mb-1.5">{o.icon}</div>
                                <span className="text-white/50 text-[11px] font-medium">
                                  {o.label}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="text-center mt-1.5">
                          <span
                            className={`text-[11px] font-medium ${a ? "text-white/90" : "text-white/30"}`}
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
                  className="shrink-0 w-9 h-9 flex items-center justify-center bg-black/50 border border-white/10 rounded-full text-white/60 hover:text-white transition-all cursor-pointer text-sm"
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
                    setLayout(overlays[overlayIndex].file);
                    addOverlayUrl(overlays[overlayIndex].file, overlays[overlayIndex].label);
                    setOverlayPickerOpen(false);
                  }}
                >
                  Use {overlays[overlayIndex].label}
                </Btn>
              </div>
            </div>
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
