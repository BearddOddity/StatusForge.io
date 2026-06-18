import { useState, useEffect, useCallback } from "react";
import "./index.css";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SparkStatus {
  hostname: string;
  connected: boolean;
  current_game: { process: string } | null;
  pin: string;
  hub_port: number;
  scan_interval: number;
  auto_push: boolean;
  last_scan: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(secs: number): string {
  if (!secs) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - secs));
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  return `${Math.floor(d / 60)}m`;
}

// ─── Tauri API wrapper (graceful fallback outside tauri) ─────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<T>(event, (e) => handler(e.payload));
    return () => { unlisten.then((fn) => fn()); };
  } catch {
    return () => {};
  }
}

async function tauriWindowDestroy(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  } catch {
    // not in tauri
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<SparkStatus | null>(null);
  const [pin, setPin] = useState("0000");

  const refresh = useCallback(async () => {
    const s = await tauriInvoke<SparkStatus>("spark_get_status");
    if (s) {
      setStatus(s);
      setPin(s.pin);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unsub = tauriListen<SparkStatus>("spark-status-update", (s) => setStatus(s));
    return () => { unsub.then((fn) => fn()); };
  }, []);

  // Demo mode: show fake data when not in tauri
  const demo = status === null;
  const display: SparkStatus = status ?? {
    hostname: "Gaming-PC",
    connected: true,
    current_game: { process: "eldenring.exe" },
    pin: "0000",
    hub_port: 53735,
    scan_interval: 5,
    auto_push: true,
    last_scan: Math.floor(Date.now() / 1000),
  };

  const online = display.connected;
  const hasGame = display.current_game !== null;
  const autoPush = display.auto_push;

  return (
    <div className="spark-root">
      {/* Header */}
      <div className="spark-header">
        <div className="spark-header-left">
          <div
            className="spark-dot animate-pulse-dot"
            style={{ background: online ? "#4ade80" : "#f87171" }}
          />
          <span className="spark-brand">SPARK</span>
        </div>
        <span className="spark-host">{display.hostname}</span>
      </div>

      {/* Body */}
      <div className="spark-body">
        {/* Detection */}
        <div className="spark-detect">
          <div className="spark-detect-label">DETECTED</div>
          <div
            className="spark-detect-name"
            style={{ color: hasGame ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.3)" }}
          >
            {hasGame ? display.current_game!.process : "Scanning..."}
          </div>
        </div>

        {/* Controls */}
        <div className="spark-controls">
          <div className="spark-row">
            <span className="spark-label">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.slice(0, 4))}
              maxLength={4}
              className="spark-input"
            />
            <button
              onClick={async () => {
                await tauriInvoke("spark_set_pin", { pin: pin.slice(0, 4) });
                refresh();
              }}
              className="spark-btn spark-btn-save"
            >
              SAVE
            </button>
          </div>

          <div className="spark-row">
            <button
              onClick={async () => { await tauriInvoke("spark_manual_push"); }}
              className="spark-btn spark-btn-action"
            >
              ⚡ PUSH
            </button>
            <button
              onClick={async () => {
                const enabled = await tauriInvoke<boolean>("spark_toggle_auto_push");
                if (enabled !== null) {
                  setStatus((s) => s ? { ...s, auto_push: enabled } : s);
                }
              }}
              className={`spark-btn spark-btn-action ${autoPush ? "spark-btn-toggle-on" : "spark-btn-toggle-off"}`}
            >
              {autoPush ? "AUTO ●" : "AUTO ○"}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="spark-footer">
          <div className="spark-footer-left">
            <span
              className="spark-status-dot"
              style={{ background: online ? "#4ade80" : "#f87171" }}
            />
            <span className="spark-status-text">{online ? "ONLINE" : "OFFLINE"}</span>
          </div>
          <span className="spark-last-scan">SCAN {timeAgo(display.last_scan)}</span>
          <span className="spark-port">PORT {display.hub_port}</span>
          <button
            onClick={async () => {
              await tauriInvoke("spark_shutdown");
              await tauriWindowDestroy();
            }}
            className="spark-btn spark-btn-exit"
          >
            ⏻ EXIT
          </button>
        </div>
      </div>
    </div>
  );
}
