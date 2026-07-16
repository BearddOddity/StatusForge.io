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
  try {
    return await invoke<Status>("get_status");
  } catch {
    return null;
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pin, setPin] = useState("");
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);

  const refresh = useCallback(async () => {
    const s = await getStatus();
    setStatus(s);
    if (s) setPin(s.pin);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<Status>("status-update", (e) => setStatus(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const online = status?.connected === true;
  const hasGame = status?.current_game?.is_playing === true;
  const autoPush = status?.auto_push !== false;

  return (
    <div className="blipy-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="blipy-header drag-region">
        <div className="blipy-header-left">
          <span
            className="blipy-dot animate-pulse-dot"
            style={{ background: online ? "rgb(52, 199, 89)" : "rgba(255, 59, 48, 0.6)" }}
          />
          <span className="blipy-brand">Blipy</span>
        </div>
        <span className="blipy-host">{status?.hostname ?? "..."}</span>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="blipy-body">
        {/* ── Now Playing + Connection ─────────────────────────────────── */}
        <div className="blipy-card">
          <div className="blipy-now-info">
            <span className="blipy-now-subtitle">
              {hasGame ? "Playing" : status?.connected ? "Idling" : "Offline"}
            </span>
            <span className="blipy-now-title">
              {hasGame
                ? status!.current_game!.title
                : status?.connected
                  ? "Just Chatting"
                  : "Offline"}
            </span>
          </div>

          <div className="blipy-status-row" style={{ marginTop: 10 }}>
            <span className="blipy-status-label">
              {online ? `Broadcasting to ${status?.hub_name ?? "Hub"}` : "Not connected"}
            </span>
          </div>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="blipy-controls">
          {/* PIN row */}
          <div className="blipy-pin-row">
            <span className="blipy-pin-label">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.slice(0, 4))}
              maxLength={4}
              className="blipy-pin-input"
            />
            <button
              onClick={async () => {
                await invoke("set_pin", { pin: pin.slice(0, 4) });
              }}
              className="blipy-btn blipy-btn-primary"
            >
              Save
            </button>
          </div>

          {/* Push + Auto toggle */}
          <div className="blipy-push-row">
            <button
              onClick={async () => {
                await invoke("manual_push");
              }}
              className="blipy-btn blipy-btn-push"
            >
              ⚡ Push
            </button>
            <button
              onClick={async () => {
                const enabled = await invoke<boolean>("toggle_auto_push");
                setStatus((s) => (s ? { ...s, auto_push: enabled } : s));
              }}
              className={`blipy-btn ${autoPush ? "blipy-btn-success" : "blipy-btn-ghost"}`}
            >
              {autoPush ? "Auto ●" : "Auto ○"}
            </button>
            <button
              title="Start Blipy when you log in (off by default)"
              onClick={async () => {
                try {
                  const next = await invoke<boolean>("set_autostart", { enabled: !autostart });
                  setAutostart(next);
                } catch {
                  /* leave toggle unchanged */
                }
              }}
              className={`blipy-btn ${autostart ? "blipy-btn-success" : "blipy-btn-ghost"}`}
            >
              {autostart ? "Boot ●" : "Boot ○"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="blipy-footer">
        <span className="blipy-footer-stat">
          Last scan {status ? timeAgo(status.last_scan) : "—"}
        </span>
        <button
          onClick={async () => {
            try {
              await invoke("shutdown_scanner");
            } catch {}
            await getCurrentWindow().destroy();
          }}
          className="blipy-btn blipy-btn-danger"
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          ⏻ Exit
        </button>
      </div>
    </div>
  );
}
