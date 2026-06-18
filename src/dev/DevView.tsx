import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Diagnostics {
  platform: string;
  engine_pid: number;
  detection_mode: string;
  native_engine_running: boolean;
  native_current_game: { title: string; process: string; platform: string } | null;
  native_process: string;
  native_is_playing: boolean;
}

interface DevSettings {
  logTailLines: number;
  autoRefresh: boolean;
  autoRefreshMs: number;
  showTimestamps: boolean;
}

const DEFAULT_SETTINGS: DevSettings = {
  logTailLines: 200,
  autoRefresh: true,
  autoRefreshMs: 2000,
  showTimestamps: true,
};

const STORAGE_KEY = "statusforge_dev_settings";

function loadSettings(): DevSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: DevSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ─── Log Level Color ──────────────────────────────────────────────────────────

function levelColor(line: string): string {
  if (line.includes("ERROR") || line.includes("FATAL")) return "text-red-400";
  if (line.includes("WARNING") || line.includes("WARN")) return "text-yellow-400";
  if (line.includes("[NATIVE]")) return "text-emerald-400";
  if (line.includes("[AUTH]")) return "text-cyan-400";
  if (line.includes("[METADATA]")) return "text-purple-400";
  if (line.includes("[SCAN]") || line.includes("[SCOUT]")) return "text-orange-400";
  if (line.includes("[FILTER]")) return "text-pink-400";
  if (line.includes("[+]")) return "text-green-400";
  if (line.includes("[-]")) return "text-red-300";
  return "text-white/40";
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DevView() {
  const [logs, setLogs] = useState<string[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [settings, setSettings] = useState<DevSettings>(loadSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Fetch logs from Rust backend
  const fetchLogs = useCallback(async () => {
    try {
      const lines = await invoke<string[]>("dev_get_log_tail", {
        lines: settings.logTailLines,
      });
      setLogs(lines || []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [settings.logTailLines]);

  // Fetch diagnostics
  const fetchDiag = useCallback(async () => {
    try {
      const d = await invoke<Diagnostics>("dev_get_diagnostics");
      setDiag(d);
    } catch {
      // native engine might not be available on macOS
      setDiag(null);
    }
  }, []);

  // Initial load
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchLogs(), fetchDiag()]);
      setLoading(false);
    })();
  }, [fetchLogs, fetchDiag]);

  // Auto-refresh
  useEffect(() => {
    if (!settings.autoRefresh) return;
    const iv = setInterval(() => {
      fetchLogs();
      fetchDiag();
    }, settings.autoRefreshMs);
    return () => clearInterval(iv);
  }, [settings.autoRefresh, settings.autoRefreshMs, fetchLogs, fetchDiag]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Save settings on change
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const updateSetting = <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-white/40 text-sm">
        Loading dev tools…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white/90 flex items-center gap-2">
            <span className="text-red-400">⚙</span> Dev Tools
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 font-semibold">
              INTERNAL
            </span>
          </h2>
          <p className="text-[11px] text-white/30 mt-0.5">
            Diagnostics, logs, and experimental settings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { fetchLogs(); fetchDiag(); }}
            className="text-[10px] px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setLogs([])}
            className="text-[10px] px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Diagnostics Panel */}
      {diag && (
        <div className="bg-black/30 border border-white/10 rounded-2xl p-4">
          <h3 className="text-xs font-semibold text-white/70 mb-3 uppercase tracking-wider">
            Diagnostics
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <DiagCard label="Platform" value={diag.platform} />
            <DiagCard label="Engine PID" value={diag.engine_pid ? String(diag.engine_pid) : "—"} />
            <DiagCard label="Detection" value={diag.detection_mode} />
            <DiagCard
              label="Native Engine"
              value={diag.native_engine_running ? "Running" : "Stopped"}
              color={diag.native_engine_running ? "text-green-400" : "text-white/30"}
            />
            <DiagCard
              label="Current Game"
              value={diag.native_current_game?.title || diag.native_process || "—"}
              span={2}
            />
            <DiagCard
              label="Playing"
              value={diag.native_is_playing ? "Yes" : "No"}
              color={diag.native_is_playing ? "text-green-400" : "text-white/30"}
            />
            <DiagCard
              label="Source"
              value={diag.native_current_game?.platform || "—"}
            />
          </div>
        </div>
      )}

      {/* Two-column: Settings + Terminal */}
      <div className="flex flex-1 gap-4 min-h-0">
        {/* Dev Settings */}
        <div className="w-[260px] shrink-0 bg-black/30 border border-white/10 rounded-2xl p-4 flex flex-col gap-4">
          <h3 className="text-xs font-semibold text-white/70 uppercase tracking-wider">
            Log Settings
          </h3>

          <div className="flex flex-col gap-3">
            <SettingRow label="Tail Lines">
              <input
                type="number"
                min={50}
                max={5000}
                step={50}
                value={settings.logTailLines}
                onChange={(e) => updateSetting("logTailLines", Math.max(50, Math.min(5000, parseInt(e.target.value) || 200)))}
                className="input-glass w-20 text-right"
              />
            </SettingRow>

            <SettingRow label="Auto Refresh">
              <Toggle
                on={settings.autoRefresh}
                onToggle={() => updateSetting("autoRefresh", !settings.autoRefresh)}
              />
            </SettingRow>

            {settings.autoRefresh && (
              <SettingRow label="Interval (ms)">
                <input
                  type="number"
                  min={500}
                  max={10000}
                  step={500}
                  value={settings.autoRefreshMs}
                  onChange={(e) => updateSetting("autoRefreshMs", Math.max(500, Math.min(10000, parseInt(e.target.value) || 2000)))}
                  className="input-glass w-20 text-right"
                />
              </SettingRow>
            )}

            <SettingRow label="Auto Scroll">
              <Toggle
                on={autoScroll}
                onToggle={() => setAutoScroll(!autoScroll)}
              />
            </SettingRow>
          </div>

          <div className="flex-grow" />

          {/* Danger zone */}
          <div className="border-t border-white/[0.06] pt-3">
            <h4 className="text-[10px] font-semibold text-red-400/60 uppercase tracking-wider mb-2">
              Danger Zone
            </h4>
            <button
              onClick={async () => {
                if (confirm("Stop the engine process?")) {
                  try {
                    await invoke("stop_engine", {});
                    fetchDiag();
                  } catch (e) {
                    setError(String(e));
                  }
                }
              }}
              className="text-[10px] px-3 py-1.5 rounded-lg bg-red-500/[0.06] border border-red-500/15 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer w-full"
            >
              Kill Engine Process
            </button>
          </div>
        </div>

        {/* Terminal Log Viewer */}
        <div className="flex-1 bg-black/60 border border-white/10 rounded-2xl flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <span className="text-[10px] text-white/30 font-mono ml-2">
                debug.log — {settings.logTailLines} lines
              </span>
            </div>
            <span className="text-[9px] text-white/20">
              {logs.length} lines
            </span>
          </div>

          <div
            ref={logRef}
            className="flex-1 overflow-y-auto overflow-x-hidden p-3 font-mono text-[11px] leading-[1.6] min-h-0"
            onScroll={() => {
              if (!logRef.current) return;
              const { scrollTop, scrollHeight, clientHeight } = logRef.current;
              setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
            }}
          >
            {error && (
              <div className="text-red-400 mb-2">Error: {error}</div>
            )}
            {logs.length === 0 && !error && (
              <div className="text-white/20">No log output yet.</div>
            )}
            {logs.map((line, i) => (
              <div key={i} className={`${levelColor(line)} break-all whitespace-pre-wrap`}>
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DiagCard({
  label,
  value,
  color,
  span,
}: {
  label: string;
  value: string;
  color?: string;
  span?: number;
}) {
  return (
    <div className={`bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2 ${span ? `col-span-${span}` : ""}`}>
      <div className="text-[9px] text-white/25 uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`text-xs font-medium truncate ${color || "text-white/70"}`}>{value}</div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-white/50">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`w-8 h-5 rounded-full relative shrink-0 transition-all duration-200 cursor-pointer outline-none border ${
        on
          ? "bg-purple-500 border-purple-400/40"
          : "bg-white/[0.07] border-white/10"
      }`}
    >
      <span
        className={`absolute top-[2px] w-3.5 h-3.5 rounded-full shadow-sm transition-all duration-200 ${
          on ? "left-[14px] bg-white" : "left-[2px] bg-white/40"
        }`}
      />
    </button>
  );
}
