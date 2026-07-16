import React, { useState, useEffect, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import appIcon from "../icons/icon.png";
import type { EngineStatus, ViewId } from "@/types";
import { fetchEngineStatus, fetchWidgetToken, tauriApi } from "@/hooks/useTauriApi";
import { loadSystemPrefs, applySystemPrefs, SYSTEM_PREFS_EVENT } from "@/systemPrefs";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useUpdater } from "@/hooks/useUpdater";
import { useToasts, ToastContainer } from "@/components/Toast";
import UpdateBanner from "@/components/UpdateBanner";
import DashboardView from "@/views/DashboardView";
import LibraryView from "@/LibraryView";
import { THEME_PREFS_EVENT, loadThemePrefs, saveThemePrefs, applyThemePrefs } from "@/theme";
import SettingsView from "@/SettingsView";
import DevView from "@/dev/DevView";

function App() {
  const [currentView, setCurrentView] = useState<ViewId>("dashboard");
  const { toasts, add: toast } = useToasts();
  const updater = useUpdater(toast, loadSystemPrefs().autoUpdateCheckEnabled);

  // Dev Tools sidebar tab visibility is a persisted System setting (Settings >
  // System > Developer Tools > "Dev Tools Tab"), not a hidden unlock gesture.
  const [showDevTools, setShowDevTools] = useState(() => loadSystemPrefs().showDevTools);

  useEffect(() => {
    const handler = () => setShowDevTools(loadSystemPrefs().showDevTools);
    window.addEventListener(SYSTEM_PREFS_EVENT, handler);
    return () => window.removeEventListener(SYSTEM_PREFS_EVENT, handler);
  }, []);

  // If the tab is hidden while it's the active view, fall back to the dashboard.
  useEffect(() => {
    if (currentView === "dev" && !showDevTools) setCurrentView("dashboard");
  }, [currentView, showDevTools]);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    running: false,
    game_title: "Initializing...",
    process_name: "",
    is_playing: false,
    genre: "",
    developer: "",
    publisher: "",
    release_date: "",
    cover_url: "",
    widgetToken: "",
  });

  const { connected: wsConnected, data: wsData } = useWebSocket(engineStatus.widgetToken);

  useEffect(() => {
    if (wsData) {
      setEngineStatus((prev) => ({
        ...prev,
        running: true,
        is_playing: wsData.is_playing || false,
        game_title: wsData.game_title || "",
        process_name: wsData.process_name || "",
        cover_url: wsData.cover_url || "",
        release_date: wsData.release_date || "",
        genre: wsData.genre || "",
        publisher: wsData.publisher || "",
        developer: wsData.developer || "",
      }));
    }
  }, [wsData]);

  const fetchStatus = useCallback(async () => {
    const [data, token] = await Promise.all([fetchEngineStatus(), fetchWidgetToken()]);
    setEngineStatus((prev) => ({
      ...prev,
      running: data.running,
      game_title: data.game_title || prev.game_title,
      process_name: data.process_name || prev.process_name,
      is_playing: data.is_playing,
      widgetToken: token,
    }));
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const NavButton = useCallback(
    ({ id, label, icon }: { id: ViewId; label: string; icon: string }) => (
      <button
        className={`nav-item ${currentView === id ? "nav-item-active" : ""}`}
        onClick={() => setCurrentView(id as ViewId)}
      >
        <span className="nav-item-icon">{icon}</span>
        <span className="nav-item-label">{label}</span>
      </button>
    ),
    [currentView]
  );

  const views = useMemo(
    () => ({
      dashboard: (
        <DashboardView
          engineStatus={engineStatus}
          wsConnected={wsConnected}
          toast={toast}
          onNavigate={setCurrentView}
        />
      ),
      settings: <SettingsView engineStatus={engineStatus} onRefresh={fetchStatus} toast={toast} />,
      library: <LibraryView toast={toast} />,
      dev: <DevView />,
    }),
    [engineStatus, wsConnected, toast, fetchStatus]
  );

  // Sidebar collapse state lives in the theme prefs ("Sidebar Icons Only" in
  // Settings > Theme). Sync both ways: the Theme tab fires THEME_PREFS_EVENT
  // after saving, and the sidebar collapse button writes back to the prefs.
  const [sidebarIconOnly, setSidebarIconOnly] = useState(() => loadThemePrefs().sidebarIconOnly);

  useEffect(() => {
    const handler = () => setSidebarIconOnly(loadThemePrefs().sidebarIconOnly);
    window.addEventListener(THEME_PREFS_EVENT, handler);
    return () => window.removeEventListener(THEME_PREFS_EVENT, handler);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarIconOnly((v: boolean) => {
      const next = !v;
      try {
        saveThemePrefs({ ...loadThemePrefs(), sidebarIconOnly: next });
      } catch {}
      return next;
    });
  }, []);

  // Apply the full saved theme (colors, background, animations, effects) on
  // mount so it works even before the user visits the Settings > Theme tab.
  useEffect(() => {
    try {
      applyThemePrefs(loadThemePrefs());
    } catch {}
  }, []);

  // System prefs boot wiring: hardware-accel class, log level, engine autostart.
  useEffect(() => {
    const prefs = loadSystemPrefs();
    applySystemPrefs(prefs);
    tauriApi("set_log_level", { level: prefs.logLevel });
    if (prefs.autoStartEngine) {
      tauriApi("start_native_engine_loop").then(() => fetchStatus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Minimize to tray: intercept window close and hide instead when enabled.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (loadSystemPrefs().minimizeToTray) {
          event.preventDefault();
          getCurrentWindow().hide();
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // Desktop notifications + custom webhook relay on engine events.
  useEffect(() => {
    const notify = async (title: string, body: string) => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title, body });
      } catch {}
    };
    const webhook = (event: string, title: string, platform?: string) => {
      const p = loadSystemPrefs();
      if (p.customWebhookEnabled && /^https?:\/\//i.test(p.customWebhookUrl)) {
        tauriApi("post_webhook", { url: p.customWebhookUrl, event, title, platform });
      }
    };
    const subs = [
      listen<{ title: string; platform?: string }>("game-detected", (e) => {
        const p = loadSystemPrefs();
        const title = e.payload?.title ?? "";
        if (p.showNotifications && p.notifyOnGameDetect) {
          notify("Game detected", title);
        }
        webhook("game-detected", title, e.payload?.platform);
      }),
      listen<string>("game-cleared", (e) => {
        const p = loadSystemPrefs();
        if (p.showNotifications && p.notifyOnStreamEvents) {
          notify("Category reset", `Back to ${e.payload}`);
        }
        webhook("game-cleared", e.payload);
      }),
      listen<string>("override-cleared", (e) => {
        toast(`Override cleared — resuming automatic detection (was ${e.payload})`, "info");
      }),
      // Fires once per up/down transition, not per failed push attempt.
      listen<string>("platform-down", (e) => {
        toast(
          `⚠️ ${e.payload} API unreachable — broadcasting paused, retrying automatically`,
          "error"
        );
      }),
      listen<string>("platform-recovered", (e) => {
        toast(`✅ ${e.payload} API recovered — broadcasting resumed`, "success");
      }),
    ];
    return () => {
      subs.forEach((s) => s.then((u) => u()).catch(() => {}));
    };
  }, []);

  return (
    <div className="flex h-screen w-full bg-transparent text-white/80 font-sans">
      {/* Sidebar */}
      <nav
        className={`sidebar-glass flex flex-col px-3 pb-5 z-10 shrink-0 ${sidebarIconOnly ? "pt-8 w-[68px] sidebar-icon-only" : "pt-1 w-[240px]"}`}
      >
        <div className={`text-center ${sidebarIconOnly ? "hidden" : ""}`}>
          <img
            src={appIcon}
            alt="StatusForge"
            className="w-full max-w-[220px] h-auto object-contain"
          />
        </div>

        <button
          className="nav-item cursor-pointer"
          onClick={toggleSidebar}
          title={sidebarIconOnly ? "Expand sidebar" : "Collapse sidebar"}
        >
          <span className="nav-item-icon">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
            >
              <rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
              <rect x="1" y="7" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
              <rect x="1" y="11" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
            </svg>
          </span>
        </button>

        <NavButton id="dashboard" label="Dashboard" icon="⏳" />
        <NavButton id="library" label="Library" icon="📚" />
        <NavButton id="settings" label="Settings" icon="⚙️" />

        {showDevTools && <NavButton id="dev" label="Dev Tools" icon="🛠" />}

        <div className="flex-grow" />

        <div className="divider mb-3" />
        <div
          className={`flex items-center gap-2.5 px-3 py-2 rounded-xl ${sidebarIconOnly ? "justify-center" : ""}`}
        >
          <span
            className={`status-dot ${engineStatus.running ? "on" : "off"}`}
            style={{
              animation: engineStatus.running
                ? "var(--user-status-pulse, pulse 2s ease-in-out infinite)"
                : "none",
            }}
          />
          {!sidebarIconOnly && (
            <span className="text-[11px] text-white/40 font-medium truncate">
              {engineStatus.running ? "Engine Online" : "Engine Offline"}
            </span>
          )}
        </div>
      </nav>

      {/* Main */}
      <main className="flex-1 p-8 overflow-y-auto overflow-x-hidden h-screen min-w-0 flex flex-col">
        <ToastContainer toasts={toasts} />
        {updater.available && (
          <UpdateBanner
            version={updater.version}
            installing={updater.installing}
            onInstall={updater.install}
            onDismiss={updater.dismiss}
          />
        )}
        {views[currentView]}
      </main>
    </div>
  );
}

export default App;
