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

        {/* ── Now Playing + Connection ─────────────────────────────────── */}
        <div className="spark-card">
          <div className="spark-now-info">
            <span className="spark-now-subtitle">
              {hasGame ? "Playing" : status?.connected ? "Idling" : "Offline"}
            </span>
            <span className="spark-now-title">
              {hasGame ? status!.current_game!.title : status?.connected ? "Just Chatting" : "Offline"}
            </span>
          </div>

          <div className="spark-status-row" style={{ marginTop: 10 }}>
            <span className="spark-status-label">
              {online ? `Broadcasting to ${status?.hub_name ?? "Hub"}` : "Not connected"}
            </span>
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
          Last scan {status ? timeAgo(status.last_scan) : "—"}
        </span>
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
