import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Status {
  connected: boolean;
  username: string;
  client_id: string;
  current_title: string | null;
  main_app_reachable: boolean;
  category_push_enabled: boolean;
  chat_announce_enabled: boolean;
  chat_bot_enabled: boolean;
  poll_interval_secs: number;
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
  const [clientId, setClientId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);

  const refresh = useCallback(async () => {
    const s = await getStatus();
    setStatus(s);
    if (s) setClientId(s.client_id);
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

  useEffect(() => {
    const unlisten = listen<{ ok: boolean }>("oauth-result", () => {
      setConnecting(false);
      refresh();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const connected = status?.connected === true;
  const reachable = status?.main_app_reachable === true;

  return (
    <div className="jb-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="jb-header drag-region">
        <div className="jb-header-left">
          <span
            className="jb-dot animate-pulse-dot"
            style={{ background: connected ? "rgb(255, 77, 103)" : "rgba(255, 255, 255, 0.2)" }}
          />
          <span className="jb-brand">Joystick Companion</span>
        </div>
        <span className="jb-status-label">{reachable ? "StatusForge OK" : "StatusForge?"}</span>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="jb-body">
        {/* ── Now Playing + Connection ─────────────────────────────────── */}
        <div className="jb-card">
          <div className="jb-now-info">
            <span className="jb-now-subtitle">
              {connected
                ? status?.username
                  ? `Connected as ${status.username}`
                  : "Connected"
                : "Not connected"}
            </span>
            <span className="jb-now-title">{status?.current_title ?? "—"}</span>
          </div>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="jb-controls">
          {!connected && (
            <div className="jb-client-row">
              <span className="jb-client-label">ID</span>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                onBlur={() => invoke("set_client_id", { clientId })}
                placeholder="Client ID"
                className="jb-client-input"
              />
            </div>
          )}

          <div className="jb-toggle-row">
            {connected ? (
              <button
                onClick={async () => {
                  await invoke("disconnect");
                  refresh();
                }}
                className="jb-btn jb-btn-danger"
                style={{ flex: 1 }}
              >
                Disconnect
              </button>
            ) : (
              <button
                disabled={connecting || !clientId.trim()}
                onClick={async () => {
                  setConnecting(true);
                  try {
                    await invoke("connect");
                  } catch {
                    setConnecting(false);
                  }
                }}
                className="jb-btn jb-btn-connect"
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>

          <div className="jb-toggle-row">
            <button
              onClick={async () => {
                const enabled = await invoke<boolean>("toggle_category_push");
                setStatus((s) => (s ? { ...s, category_push_enabled: enabled } : s));
              }}
              className={`jb-btn ${status?.category_push_enabled ? "jb-btn-success" : "jb-btn-ghost"}`}
            >
              Category {status?.category_push_enabled ? "●" : "○"}
            </button>
            <button
              onClick={async () => {
                const enabled = await invoke<boolean>("toggle_chat_announce");
                setStatus((s) => (s ? { ...s, chat_announce_enabled: enabled } : s));
              }}
              className={`jb-btn ${status?.chat_announce_enabled ? "jb-btn-success" : "jb-btn-ghost"}`}
            >
              Announce {status?.chat_announce_enabled ? "●" : "○"}
            </button>
            <button
              onClick={async () => {
                const enabled = await invoke<boolean>("toggle_chat_bot");
                setStatus((s) => (s ? { ...s, chat_bot_enabled: enabled } : s));
              }}
              className={`jb-btn ${status?.chat_bot_enabled ? "jb-btn-success" : "jb-btn-ghost"}`}
            >
              Chat Bot {status?.chat_bot_enabled ? "●" : "○"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="jb-footer">
        <button
          title="Start Joystick Bot when you log in (off by default)"
          onClick={async () => {
            try {
              const next = await invoke<boolean>("set_autostart", { enabled: !autostart });
              setAutostart(next);
            } catch {
              /* leave toggle unchanged */
            }
          }}
          className={`jb-btn ${autostart ? "jb-btn-success" : "jb-btn-ghost"}`}
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          {autostart ? "Boot ●" : "Boot ○"}
        </button>
        <button
          onClick={async () => {
            try {
              await invoke("shutdown_bot");
            } catch {
              /* ignore */
            }
            await getCurrentWindow().destroy();
          }}
          className="jb-btn jb-btn-danger"
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          ⏻ Exit
        </button>
      </div>
    </div>
  );
}
