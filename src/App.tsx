import { useState, useEffect, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import appIcon from "./assets/icon.png";
import "./index.css";
import type { EngineStatus, ViewId } from "@statusforge/types";
import { fetchEngineStatus, fetchOverlayToken, tauriApi } from "@statusforge/hooks/useTauriApi";
import {
  loadSystemPrefs,
  saveSystemPrefs,
  applySystemPrefs,
  SYSTEM_PREFS_EVENT,
} from "@statusforge/systemPrefs";
import { useWebSocket } from "@statusforge/hooks/useWebSocket";
import { useUpdater } from "@statusforge/hooks/useUpdater";
import { useToasts, ToastContainer } from "@statusforge/components/Toast";
import UpdateBanner from "@statusforge/components/UpdateBanner";
import DashboardView from "@statusforge/views/DashboardView";
import LibraryView from "@statusforge/LibraryView";
import { THEME_PREFS_EVENT, loadThemePrefs, saveThemePrefs, applyThemePrefs } from "@statusforge/theme";
import SettingsView from "@statusforge/SettingsView";
import DevView from "@statusforge/dev/DevView";
import OnboardingWizard from "@statusforge/components/OnboardingWizard";

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

  // First-launch setup wizard — also re-shown on demand via the "Replay
  // Setup Guide" button in Settings > System.
  const [showOnboarding, setShowOnboarding] = useState(() => !loadSystemPrefs().onboardingComplete);

  useEffect(() => {
    const handler = () => setShowOnboarding(!loadSystemPrefs().onboardingComplete);
    window.addEventListener(SYSTEM_PREFS_EVENT, handler);
    return () => window.removeEventListener(SYSTEM_PREFS_EVENT, handler);
  }, []);

  const finishOnboarding = useCallback(() => {
    saveSystemPrefs({ ...loadSystemPrefs(), onboardingComplete: true });
    setShowOnboarding(false);
  }, []);

  // "Browse other overlay styles in the Dashboard" (onboarding's Overlay
  // step) used to just switch views while the wizard stayed rendered on top
  // of everything, so the Dashboard — and its overlay picker — was there but
  // completely unreachable. Hiding the wizard (without marking onboarding
  // complete) and auto-opening the picker on arrival makes the link actually
  // do what it says; a small pill brings the wizard back afterward.
  const [onboardingHidden, setOnboardingHidden] = useState(false);
  const [openOverlayPickerSignal, setOpenOverlayPickerSignal] = useState(false);
  const browseOverlaysFromOnboarding = useCallback(() => {
    setOnboardingHidden(true);
    setCurrentView("dashboard");
    setOpenOverlayPickerSignal(true);
  }, []);

  // "Struggling to get set up?" banner on the Dashboard — same mechanism as
  // Settings > System's "Replay Setup Guide" button.
  const startOnboarding = useCallback(() => {
    setOnboardingHidden(false);
    saveSystemPrefs({ ...loadSystemPrefs(), onboardingComplete: false });
  }, []);

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
    overlayToken: "",
  });

  const { connected: wsConnected, data: wsData } = useWebSocket(engineStatus.overlayToken);

  useEffect(() => {
    if (wsData) {
      setEngineStatus((prev) => ({
        ...prev,
        running: wsData.running,
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
    const [data, token] = await Promise.all([fetchEngineStatus(), fetchOverlayToken()]);
    setEngineStatus((prev) => ({
      ...prev,
      running: data.running,
      game_title: data.game_title || prev.game_title,
      process_name: data.process_name || prev.process_name,
      is_playing: data.is_playing,
      overlayToken: token,
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
          onRefresh={fetchStatus}
          openOverlayPicker={openOverlayPickerSignal}
          onOverlayPickerOpened={() => setOpenOverlayPickerSignal(false)}
          onStartOnboarding={startOnboarding}
        />
      ),
      settings: <SettingsView engineStatus={engineStatus} onRefresh={fetchStatus} toast={toast} />,
      library: <LibraryView toast={toast} />,
      dev: <DevView />,
    }),
    [engineStatus, wsConnected, toast, fetchStatus, openOverlayPickerSignal, startOnboarding]
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
      tauriApi("start_engine").then(() => fetchStatus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Minimize to tray: intercept window close and hide instead when enabled.
  // Cleanup awaits the same promise the setup started (rather than a separate
  // `unlisten` variable) so a fast mount/unmount — e.g. StrictMode's dev-only
  // double-invoke — can't run cleanup before the listener finishes
  // registering, which would otherwise leak a permanent extra listener.
  useEffect(() => {
    const unlistenPromise = getCurrentWindow()
      .onCloseRequested((event) => {
        if (loadSystemPrefs().minimizeToTray) {
          event.preventDefault();
          getCurrentWindow().hide();
        }
      })
      .catch(() => undefined);
    return () => {
      unlistenPromise.then((u) => u?.());
    };
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
      // Weekly library sync found a renamed/re-issued category id.
      listen<{ title: string; platform: string; old_id: string; new_id: string }>(
        "library-item-synced",
        (e) => {
          toast(`${e.payload.title} category updated on ${e.payload.platform}`, "success");
        }
      ),
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
      {showOnboarding && (
        <OnboardingWizard
          onFinish={finishOnboarding}
          onBrowseOverlays={browseOverlaysFromOnboarding}
          hidden={onboardingHidden}
        />
      )}
      {showOnboarding && onboardingHidden && (
        <button
          onClick={() => setOnboardingHidden(false)}
          className="fixed bottom-5 right-5 z-[290] px-4 py-2.5 rounded-full text-xs font-semibold text-white cursor-pointer shadow-lg transition-transform hover:scale-105"
          style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
        >
          ← Resume Setup Guide
        </button>
      )}
    </div>
  );
}

export default App;
