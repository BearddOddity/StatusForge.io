import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { EngineStatus, ViewId } from "@/types";
import { fetchEngineStatus, fetchWidgetToken } from "@/hooks/useTauriApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useToasts, ToastContainer } from "@/components/Toast";
import { invoke } from "@tauri-apps/api/core";

import DashboardView from "@/views/DashboardView";
import EngineConfigView from "@/views/EngineConfigView";
import ApiKeysView from "@/views/ApiKeysView";
import RoutingView from "@/views/RoutingView";
import LibraryView from "@/LibraryView";
import SettingsView from "@/SettingsView";
import DevView from "@/dev/DevView";

function App() {
  const [currentView, setCurrentView] = useState<ViewId>("dashboard");
  const [appVersion] = useState("1.0.8");
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

  return (
    <div className="flex h-screen w-full bg-[#050505] text-white/80 font-sans">
      {/* Sidebar */}
      <nav className={`sidebar-glass flex flex-col px-3 py-5 z-10 ${sidebarIconOnly ? "sidebar-icon-only" : "w-[240px] shrink-0"}`}>
        <div className="px-3 pb-5 text-center">
          <img
            src="/icon.png"
            alt="StatusForge"
            className="w-full max-w-[220px] h-auto object-contain"
          />
          <div
            className="badge badge-ghost mt-3 mx-auto w-fit cursor-pointer select-none"
            onClick={handleDevUnlock}
            title="StatusForge"
          >
            v{appVersion}
          </div>
        </div>

        <NavButton id="dashboard" label="Status Room" icon="⏳" />
        <NavButton id="library" label="Library" icon="📚" />
        <NavButton id="settings" label="Settings" icon="⚙️" />

        <button
          onClick={async () => {
            try { await invoke("spark_toggle_window"); } catch {}
          }}
          className="nav-item"
          title="Spark"
        >
          <span className="nav-item-icon">⚡</span>
          {!sidebarIconOnly && <span className="nav-item-label">Spark</span>}
        </button>

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
