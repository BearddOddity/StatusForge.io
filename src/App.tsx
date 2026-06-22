import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import appIcon from "../icons/icon.png";
import type { EngineStatus, ViewId } from "@/types";
import { fetchEngineStatus, fetchWidgetToken } from "@/hooks/useTauriApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useToasts, ToastContainer } from "@/components/Toast";
import DashboardView from "@/views/DashboardView";
import EngineConfigView from "@/views/EngineConfigView";
import ApiKeysView from "@/views/ApiKeysView";
import RoutingView from "@/views/RoutingView";
import LibraryView from "@/LibraryView";
import SettingsView from "@/SettingsView";
import DevView from "@/dev/DevView";

function App() {
  const [currentView, setCurrentView] = useState<ViewId>("dashboard");
  const [appVersion] = useState("0.5.0");
  const [devUnlocked, setDevUnlocked] = useState(false);
  const devClickRef = useRef(0);
  const devTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, add: toast } = useToasts();

  const handleDevUnlock = useCallback(() => {
    devClickRef.current += 1;
    if (devTimerRef.current) clearTimeout(devTimerRef.current);
    devTimerRef.current = setTimeout(() => {
      devClickRef.current = 0;
    }, 3000);
    if (devClickRef.current >= 7) {
      setDevUnlocked(true);
      devClickRef.current = 0;
      if (devTimerRef.current) clearTimeout(devTimerRef.current);
      toast("🔓 Dev Tools unlocked", "info");
    }
  }, [toast]);

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

  const { connected: wsConnected, data: wsData } = useWebSocket(
    engineStatus.widgetToken
  );

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
    const [data, token] = await Promise.all([
      fetchEngineStatus(),
      fetchWidgetToken(),
    ]);
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

  const NavButton = useCallback(({
    id,
    label,
    icon,
  }: {
    id: ViewId;
    label: string;
    icon: string;
  }) => (
    <button
      className={`nav-item ${currentView === id ? "nav-item-active" : ""}`}
      onClick={() => setCurrentView(id as ViewId)}
    >
      <span className="nav-item-icon">{icon}</span>
      <span className="nav-item-label">{label}</span>
    </button>
  ), [currentView]);

  const views = useMemo(() => ({
    dashboard: (
      <DashboardView
        engineStatus={engineStatus}
        wsConnected={wsConnected}
        toast={toast}
      />
    ),
    settings: (
      <SettingsView
        engineStatus={engineStatus}
        onRefresh={fetchStatus}
        toast={toast}
        devUnlocked={devUnlocked}
      />
    ),
    library: <LibraryView toast={toast} />,
    dev: <DevView />,
  }), [engineStatus, wsConnected, toast, fetchStatus, devUnlocked]);

  const [sidebarIconOnly, setSidebarIconOnly] = useState(() => {
    try {
      const stored = localStorage.getItem("statusforge_system_prefs");
      return stored ? JSON.parse(stored).sidebarIconOnly ?? false : false;
    } catch { return false; }
  });

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "statusforge_system_prefs" && e.newValue) {
        try { setSidebarIconOnly(JSON.parse(e.newValue).sidebarIconOnly ?? false); } catch {}
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Apply saved theme (background, colors, etc.) on mount so it works
  // even before the user visits the Settings > Theme tab.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("statusforge_theme_prefs");
      if (!stored) return;
      const prefs = JSON.parse(stored);
      const root = document.documentElement;
      if (prefs.accentColor) root.style.setProperty("--user-accent", prefs.accentColor);
      if (prefs.bgColor) root.style.setProperty("--user-bg", prefs.bgColor);
      root.style.setProperty("--user-bg-opacity", String((prefs.bgOpacity ?? 100) / 100));
      root.style.setProperty("--user-bg-blur", `${prefs.bgBlur ?? 0}px`);
      root.style.setProperty("--user-bg-image", prefs.bgImage ? `url(${prefs.bgImage})` : "none");
      root.style.setProperty("--user-panel-opacity", String((prefs.panelOpacity ?? 30) / 100));
      root.style.setProperty("--user-font-scale", String((prefs.fontScale ?? 100) / 100));
      const radius = prefs.borderRadius === "sharp" ? "2px" : prefs.borderRadius === "soft" ? "8px" : "16px";
      root.style.setProperty("--user-radius", radius);
      root.style.setProperty("--user-density", prefs.density === "compact" ? "0.75rem" : prefs.density === "spacious" ? "1.5rem" : "1rem");
    } catch {}
  }, []);

  return (
    <div className="flex h-screen w-full bg-transparent text-white/80 font-sans">
      {/* Sidebar */}
      <nav className={`sidebar-glass flex flex-col px-3 pb-5 z-10 shrink-0 ${sidebarIconOnly ? "pt-8 w-[68px] sidebar-icon-only" : "pt-1 w-[240px]"}`}>
        <div className={`text-center ${sidebarIconOnly ? "hidden" : ""}`}>
          <img
            src={appIcon}
            alt="StatusForge"
            className="w-full max-w-[220px] h-auto object-contain"
          />

        </div>

        <button
          className="nav-item cursor-pointer"
          onClick={() => setSidebarIconOnly((v) => !v)}
          title={sidebarIconOnly ? "Expand sidebar" : "Collapse sidebar"}
        >
          <span className="nav-item-icon">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-4 h-4">
              <rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
              <rect x="1" y="7" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
              <rect x="1" y="11" width="14" height="2" rx="1" fill="currentColor" opacity="0.7" />
            </svg>
          </span>

        </button>

        <NavButton id="dashboard" label="Status Room" icon="⏳" />
        <NavButton id="library" label="Library" icon="📚" />
        <NavButton id="settings" label="Settings" icon="⚙️" />

        {devUnlocked && (
          <NavButton id="dev" label="Dev Tools" icon="🛠" />
        )}

        <div className="flex-grow" />

        <div className="divider mb-3" />
        <div className={`flex items-center gap-2.5 px-3 py-2 rounded-xl ${sidebarIconOnly ? "justify-center" : ""}`}>
          <span
            className={`status-dot ${engineStatus.running ? "on" : "off"}`}
            style={{ animation: engineStatus.running ? "var(--user-status-pulse, pulse 2s ease-in-out infinite)" : "none" }}
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
        {views[currentView]}
      </main>
    </div>
  );
}

export default App;
