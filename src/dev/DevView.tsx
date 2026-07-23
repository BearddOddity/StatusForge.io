import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// Module-scoped (not component state): App.tsx only renders `views[currentView]`,
// so switching away from Dev Tools (including toggling its sidebar visibility
// off) fully unmounts DevView. A useRef would reset on remount and silently
// undo "Clear" the moment you navigate back. These live for the process's
// whole run and reset only on a full app restart, matching what "Clear" should
// actually mean here.
let lastTotalLines = 0;
let clearedAtLine: number | null = null;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Diagnostics {
  platform: string;
  engine_pid: number;
  engine_running: boolean;
  current_game: { title: string; process: string; platform: string } | null;
  current_process: string;
  is_playing: boolean;
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
  if (line.includes("[ENGINE]")) return "text-emerald-400";
  if (line.includes("[AUTH]")) return "text-cyan-400";
  if (line.includes("[METADATA]")) return "text-purple-400";
  if (line.includes("[SCAN]") || line.includes("[SCOUT]")) return "text-orange-400";
  if (line.includes("[FILTER]")) return "text-pink-400";
  if (line.includes("[+]")) return "text-green-400";
  if (line.includes("[-]")) return "text-red-300";
  return "text-white/40";
}

// ─── Plain-language log interpreter ─────────────────────────────────────────────
// Classifies a raw debug.log line and, where we recognise it, rewrites it into a
// sentence a non-developer can act on. Unknown lines fall back to the raw text.

type LogLevel = "error" | "warn" | "info" | "debug";

function lineLevel(line: string): LogLevel {
  const l = line.toLowerCase();
  if (l.includes("[error]") || l.includes("fatal") || l.includes("panic")) return "error";
  // Real problems that log at WARN, plus generic failure words.
  if (
    l.includes("[warn]") ||
    l.includes("failed") ||
    l.includes("unauthorized") ||
    l.includes("token refresh") ||
    l.includes("permission") ||
    l.includes("address in use") ||
    l.includes("could not") ||
    l.includes("couldn't")
  )
    return "warn";
  // "[ENGINE] debug [FILTER] ..." style lines are routine, not info.
  if (l.includes(" debug ") || l.includes("[filter]")) return "debug";
  return "info";
}

// Ordered pattern → plain-English rewrite. First match wins. `$1` is filled from
// the capture group when present (e.g. the game/category name).
const HUMANIZE: { re: RegExp; msg: (m: RegExpMatchArray) => string }[] = [
  // Toasts mirrored from the UI — already plain English, just drop the tag.
  { re: /\[TOAST\]\s*(.+)/, msg: (m) => m[1]!.trim() },
  // Detection lifecycle
  { re: /NEW GAME:\s*(.+?)\s*\((.+?)\)/, msg: (m) => `🎮 Detected game: ${m[1]} — via ${m[2]}.` },
  {
    re: /Grace period expired\. Dropping:\s*(.+)/,
    msg: (m) =>
      `⏹ Stopped showing "${m[1]!.trim()}" — the game closed or stayed out of focus past the grace period.`,
  },
  // Category push — success
  {
    re: /\[PUSH\] Twitch category set to "(.+?)"/,
    msg: (m) => `✅ Updated your Twitch category to "${m[1]}".`,
  },
  { re: /\[PUSH\] Kick category set/, msg: () => `✅ Updated your Kick category.` },
  {
    re: /\[PUSH\] (Twitch|Kick) token expired — refreshing/,
    msg: (m) => `🔄 Your ${m[1]} login expired — refreshing it automatically.`,
  },
  // Category push — problems
  {
    re: /\[PUSH\] Twitch:? no game id for "(.+?)"/,
    msg: (m) =>
      `⚠ No matching Twitch category found for "${m[1]}", so your Twitch category was left unchanged.`,
  },
  {
    re: /\[PUSH\] Kick:? no category id for "(.+?)"/,
    msg: (m) =>
      `⚠ No matching Kick category found for "${m[1]}", so your Kick category was left unchanged.`,
  },
  {
    re: /\[PUSH\] (Twitch|Kick) retry still unauthorized/,
    msg: (m) =>
      `❌ Couldn't update your ${m[1]} channel — your login was rejected even after refreshing. Reconnect ${m[1]} in Settings → API & Routing.`,
  },
  {
    re: /\[PUSH\] (Twitch|Kick) token refresh failed/,
    msg: (m) =>
      `❌ Couldn't refresh your ${m[1]} login. Reconnect ${m[1]} in Settings → API & Routing.`,
  },
  {
    re: /\[PUSH\] Failed to save refreshed (Twitch|Kick) token/,
    msg: (m) =>
      `⚠ Refreshed your ${m[1]} login but couldn't save it — check that your settings file isn't read-only.`,
  },
  // Startup / system
  {
    re: /Widget\/OAuth server listening/,
    msg: () => `✅ Local server is up (port 53735) — overlays and login can connect.`,
  },
  {
    re: /Engine loop started\. Grace:\s*(\d+)s, Interval:\s*(\d+)s/,
    msg: (m) =>
      `▶ Detection engine started (checks every ${m[2]}s, ${m[1]}s grace before dropping a game).`,
  },
  {
    re: /address in use|Address already in use/,
    msg: () =>
      `❌ Port 53735 is already in use by another program. Close it (or the other copy of StatusForge) and restart.`,
  },
  {
    re: /Screen Recording|permission/i,
    msg: () =>
      `⚠ macOS needs Screen Recording permission to read window titles. Grant it in System Settings → Privacy & Security, then restart.`,
  },
  {
    re: /Failed to bootstrap Config\.json/,
    msg: () =>
      `❌ Couldn't create your settings file on first run — check folder write permissions.`,
  },
  {
    re: /Failed to generate initial widget token/,
    msg: () =>
      `⚠ Couldn't create an overlay security token — overlays may not connect until you regenerate it in Settings → Engine.`,
  },
];

// Routine filter lines → short reasons (only shown in Friendly mode, as debug).
const FILTER_REASONS: { re: RegExp; msg: string }[] = [
  { re: /RAM floor not met/, msg: "Ignored a program using too little memory to be a game." },
  {
    re: /Chromium\/Electron shell trapped/,
    msg: "Ignored an Electron/Chromium app (Discord, Spotify, VS Code, etc.).",
  },
  { re: /Desktop UI framework trapped/, msg: "Ignored a desktop tool (Qt/GTK/MFC window)." },
  { re: /Background\/helper cmdline trapped/, msg: "Ignored a background/helper process." },
  { re: /Window too small/, msg: "Ignored a window too small to be a game." },
  { re: /parked off-screen/, msg: "Ignored a window hidden off-screen." },
];

/** Returns a friendly sentence for a line, or null to keep the raw text. */
function humanize(line: string): string | null {
  for (const { re, msg } of HUMANIZE) {
    const m = line.match(re);
    if (m) return msg(m);
  }
  for (const { re, msg } of FILTER_REASONS) {
    if (re.test(line)) return msg;
  }
  // Generic error/warn with no specific rule: strip the log prefix noise.
  const lvl = lineLevel(line);
  if (lvl === "error" || lvl === "warn") {
    const stripped = line.replace(/^\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\s*/, "").trim();
    return stripped || null;
  }
  return null;
}

const LEVEL_STYLE: Record<LogLevel, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-white/70",
  debug: "text-white/30",
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DevView() {
  const [logs, setLogs] = useState<string[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [settings, setSettings] = useState<DevSettings>(loadSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [friendly, setFriendly] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);

  // Rows to render: classify, optionally filter to problems, optionally humanize.
  const rows = logs
    .map((raw) => ({ raw, level: lineLevel(raw), plain: humanize(raw) }))
    .filter((r) => (errorsOnly ? r.level === "error" || r.level === "warn" : true));
  const errorCount = logs.filter((l) => {
    const lv = lineLevel(l);
    return lv === "error" || lv === "warn";
  }).length;

  // Export just the error/warn lines from the currently loaded tail — raw
  // text (not humanized) so it's useful to paste/attach when reporting a bug.
  // Written by the Rust side to Documents/StatusForge Logs (a fixed, findable
  // spot) rather than wherever the browser-style download default lands.
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const exportErrorLogs = async () => {
    const errorLines = logs.filter((l) => {
      const lv = lineLevel(l);
      return lv === "error" || lv === "warn";
    });
    const content = errorLines.length
      ? errorLines.join("\n")
      : "(no errors or warnings in the current log tail)";
    try {
      const path = await invoke<string>("dev_export_error_log", { content });
      setExportedPath(path);
      setTimeout(() => setExportedPath(null), 4000);
    } catch (e) {
      setExportedPath(`Export failed: ${String(e)}`);
      setTimeout(() => setExportedPath(null), 4000);
    }
  };

  // "Clear" only clears what's displayed — debug.log itself keeps growing, and
  // auto-refresh re-tails it every couple seconds. Content-matching a "last
  // line" marker doesn't work here: the log is full of exact-duplicate lines
  // (e.g. "RAM floor not met" every scan tick), so matching by text can cut
  // at the wrong occurrence. Instead track the file's total line count at
  // clear time and only show lines past it — reliable regardless of
  // duplicate content or how far the tail window has to reach.
  const handleClear = () => {
    clearedAtLine = lastTotalLines;
    setLogs([]);
  };

  // Fetch logs from Rust backend
  const fetchLogs = useCallback(async () => {
    try {
      const res = await invoke<{ lines: string[]; total_lines: number }>("dev_get_log_tail", {
        lines: settings.logTailLines,
      });
      const tail = res.lines || [];
      lastTotalLines = res.total_lines;
      if (clearedAtLine !== null) {
        const newCount = Math.max(0, res.total_lines - clearedAtLine);
        setLogs(newCount > 0 ? tail.slice(Math.max(0, tail.length - newCount)) : []);
      } else {
        setLogs(tail);
      }
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
      // engine diagnostics might not be available on macOS
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
            <DiagCard
              label="Engine"
              value={diag.engine_running ? "Running" : "Stopped"}
              color={diag.engine_running ? "text-green-400" : "text-white/30"}
            />
            <DiagCard
              label="Current Game"
              value={diag.current_game?.title || diag.current_process || "—"}
              span={2}
            />
            <DiagCard
              label="Playing"
              value={diag.is_playing ? "Yes" : "No"}
              color={diag.is_playing ? "text-green-400" : "text-white/30"}
            />
            <DiagCard label="Source" value={diag.current_game?.platform || "—"} />
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

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                onClick={() => {
                  fetchLogs();
                  fetchDiag();
                }}
                className="flex-1 text-[10px] px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
              >
                ↻ Refresh
              </button>
              <button
                onClick={handleClear}
                className="flex-1 text-[10px] px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] transition-all cursor-pointer"
              >
                Clear
              </button>
            </div>
            <button
              onClick={exportErrorLogs}
              className="text-[10px] px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all cursor-pointer w-full"
            >
              {exportedPath
                ? "✓ Exported"
                : `⬇ Export Errors${errorCount ? ` (${errorCount})` : ""}`}
            </button>
            {exportedPath && (
              <div className="text-[9px] text-white/40 font-mono truncate" title={exportedPath}>
                Saved to {exportedPath}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <SettingRow label="Tail Lines">
              <input
                type="number"
                min={50}
                max={5000}
                step={50}
                value={settings.logTailLines}
                onChange={(e) =>
                  updateSetting(
                    "logTailLines",
                    Math.max(50, Math.min(5000, parseInt(e.target.value) || 200))
                  )
                }
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
                  onChange={(e) =>
                    updateSetting(
                      "autoRefreshMs",
                      Math.max(500, Math.min(10000, parseInt(e.target.value) || 2000))
                    )
                  }
                  className="input-glass w-20 text-right"
                />
              </SettingRow>
            )}

            <SettingRow label="Auto Scroll">
              <Toggle on={autoScroll} onToggle={() => setAutoScroll(!autoScroll)} />
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
              <span className="text-[10px] text-white/30 font-mono ml-2">debug.log</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setFriendly((v) => !v)}
                title="Rewrite log lines into plain English"
                className={`text-[9px] px-2 py-1 rounded-md border transition-colors cursor-pointer ${
                  friendly
                    ? "bg-purple-500/15 border-purple-500/25 text-purple-300"
                    : "bg-white/[0.04] border-white/10 text-white/40 hover:text-white/70"
                }`}
              >
                {friendly ? "Plain English" : "Raw"}
              </button>
              <button
                onClick={() => setErrorsOnly((v) => !v)}
                title="Show only warnings and errors"
                className={`text-[9px] px-2 py-1 rounded-md border transition-colors cursor-pointer ${
                  errorsOnly
                    ? "bg-red-500/15 border-red-500/25 text-red-300"
                    : "bg-white/[0.04] border-white/10 text-white/40 hover:text-white/70"
                }`}
              >
                Errors only{errorCount ? ` (${errorCount})` : ""}
              </button>
            </div>
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
            {error && <div className="text-red-400 mb-2">Error: {error}</div>}
            {rows.length === 0 && !error && (
              <div className="text-white/20">
                {errorsOnly ? "No warnings or errors 🎉" : "No log output yet."}
              </div>
            )}
            {rows.map((r, i) => {
              const showPlain = friendly && r.plain;
              return (
                <div
                  key={i}
                  title={showPlain ? r.raw : undefined}
                  className={`${
                    showPlain ? LEVEL_STYLE[r.level] : levelColor(r.raw)
                  } break-all whitespace-pre-wrap`}
                >
                  {showPlain ? r.plain : r.raw}
                </div>
              );
            })}
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
    <div
      className={`bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2 ${span ? `col-span-${span}` : ""}`}
    >
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
        on ? "bg-purple-500 border-purple-400/40" : "bg-white/[0.07] border-white/10"
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
