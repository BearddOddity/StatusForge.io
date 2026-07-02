import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { timeAgo } from "./helpers";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Status {
  hostname: string;
  connected: boolean;
  current_game: { title: string; process: string; is_playing: boolean } | null;
  hub_name: string | null;
  pin: string;
  hub_port: number;
  scan_interval: number;
  auto_push: boolean;
  last_scan: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getStatus(): Promise<Status | null> {
  try { return await invoke<Status>("get_status"); }
  catch { return null; }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pin, setPin] = useState("");
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart").then(setAutostart).catch(() => setAutostart(false));
  }, []);

  const refresh = useCallback(async () => {
    const s = await getStatus();
    setStatus(s);
    if (s) setPin(s.pin);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unlisten = listen<Status>("status-update", (e) => setStatus(e.payload));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const online = status?.connected === true;
  const hasGame = status?.current_game?.is_playing === true;
  const autoPush = status?.auto_push !== false;

  return (
    <div className="spark-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="spark-header drag-region">
        <div className="spark-header-left">
          <span
            className="spark-dot animate-pulse-dot"
            style={{ background: online ? "rgb(52, 199, 89)" : "rgba(255, 59, 48, 0.6)" }}
          />
          <span className="spark-brand">Spark</span>
        </div>
        <span className="spark-host">{status?.hostname ?? "..."}</span>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="spark-body">

        {/* ── Now Playing ──────────────────────────────────────────────── */}
        <div className="spark-card">
          <div className="spark-section-label">Now Playing</div>
          <div className="spark-now-playing">
            <div className="spark-cover">
              <div style={{
                width: "100%", height: "100%",
                background: "linear-gradient(135deg, #1a1a2e, #16213e)",
              }} />
              {hasGame && <div className="spark-cover-playing" />}
            </div>
            <div className="spark-now-info">
              <span className="spark-now-subtitle">
                {hasGame ? "Playing" : status?.connected ? "Idling" : "Offline"}
              </span>
              <span className="spark-now-title">
                {hasGame ? status!.current_game!.title : status?.connected ? "Just Chatting" : "Offline"}
              </span>
              <span className="spark-now-process">
                {status?.current_game?.process || (status?.connected ? "No active process" : "Start the engine to begin")}
              </span>
            </div>
          </div>
        </div>

        {/* ── Status ───────────────────────────────────────────────────── */}
        <div className="spark-card">
          <div className="spark-section-label">Status</div>

          {/* Connection */}
          <div className="spark-status-row" style={{ marginBottom: 8 }}>
            <div className="spark-status-left">
              <span
                className="spark-status-dot"
                style={{ background: online ? "rgb(52, 199, 89)" : "rgba(255, 255, 255, 0.2)" }}
              />
              <span className="spark-status-label">Connection</span>
            </div>
            <div className="spark-status-right">
              <span
                className="spark-status-dot animate-pulse-dot"
                style={{
                  background: online ? "rgb(52, 199, 89)" : "rgba(255, 255, 255, 0.2)",
                  animationDuration: online ? "2s" : "0s",
                }}
              />
              <span className="spark-status-value">
                {online ? `Broadcasting to ${status?.hub_name ?? "Hub"}` : "Offline"}
              </span>
            </div>
          </div>

          {/* Scan interval bar */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1.2 }}>Scan</span>
              <span className="spark-status-mono">{status ? timeAgo(status.last_scan) : "—"}</span>
            </div>
            <div className="spark-progress-track">
              <div
                className="spark-progress-fill"
                style={{
                  width: online ? "68%" : "0%",
                  background: "linear-gradient(to right, rgba(145, 70, 255, 0.6), rgba(145, 70, 255, 0.4))",
                }}
              />
            </div>
          </div>

          {/* Port */}
          <div className="spark-status-row">
            <div className="spark-status-left">
              <span className="spark-status-label">Port</span>
            </div>
            <span className="spark-status-mono">{status?.hub_port ?? 53735}</span>
          </div>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="spark-controls">
          {/* PIN row */}
          <div className="spark-pin-row">
            <span className="spark-pin-label">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.slice(0, 4))}
              maxLength={4}
              className="spark-pin-input"
            />
            <button
              onClick={async () => { await invoke("set_pin", { pin: pin.slice(0, 4) }); }}
              className="spark-btn spark-btn-primary"
            >
              Save
            </button>
          </div>

          {/* Push + Auto toggle */}
          <div className="spark-push-row">
            <button
              onClick={async () => { await invoke("manual_push"); }}
              className="spark-btn spark-btn-push"
            >
              ⚡ Push
            </button>
            <button
              onClick={async () => {
                const enabled = await invoke<boolean>("toggle_auto_push");
                setStatus((s) => s ? { ...s, auto_push: enabled } : s);
              }}
              className={`spark-btn ${autoPush ? "spark-btn-success" : "spark-btn-ghost"}`}
            >
              {autoPush ? "Auto ●" : "Auto ○"}
            </button>
            <button
              title="Start Spark when you log in (off by default)"
              onClick={async () => {
                try {
                  const next = await invoke<boolean>("set_autostart", { enabled: !autostart });
                  setAutostart(next);
                } catch { /* leave toggle unchanged */ }
              }}
              className={`spark-btn ${autostart ? "spark-btn-success" : "spark-btn-ghost"}`}
            >
              {autostart ? "Boot ●" : "Boot ○"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="spark-footer">
        <span className="spark-footer-stat">
          <span
            className="spark-dot-sm"
            style={{ background: online ? "rgb(52, 199, 89)" : "rgba(255, 59, 48, 0.6)" }}
          />
          {online ? "ONLINE" : "OFFLINE"}
        </span>
        <span className="spark-footer-stat">SCAN {status ? timeAgo(status.last_scan) : "—"}</span>
        <span className="spark-footer-stat">PORT {status?.hub_port ?? 53735}</span>
        <button
          onClick={async () => {
            try { await invoke("shutdown_scanner"); } catch {}
            await getCurrentWindow().destroy();
          }}
          className="spark-btn spark-btn-danger"
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          ⏻ Exit
        </button>
      </div>
    </div>
  );
}
