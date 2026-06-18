import { useState, useEffect, useCallback, useMemo } from "react";
import type { ForgeLibraryEntry, ToastType } from "@/types";
import { fetchWidgetToken } from "@/hooks/useTauriApi";
import { Card, Btn } from "@/components/ui";
import CarouselView from "@/components/CarouselView";
import GridView from "@/components/GridView";
import { MetadataOverlay, ExiledPanel, AddGamePanel } from "@/components/Overlays";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ExiledEntry {
  process: string;
}

type ViewMode = "carousel" | "grid";

// ═══════════════════════════════════════════════════════════════════════════════
// DUMMY DATA — dev preview when engine is offline
// ═══════════════════════════════════════════════════════════════════════════════

function getDummyLibrary(): ForgeLibraryEntry[] {
  return [
    {
      title: "Celeste", genre: "PLATFORMER", release_year: "2018",
      developer: "Maddy Makes Games", publisher: "Maddy Makes Games",
      cover_url: "https://shared.steamstatic.com/store_item_assets/steam/apps/504230/library_600x900.jpg",
      steam_id: "504230", igdb_id: "12345", rawg_id: "58175", twitch_id: "493997", kick_id: "12345",
    },
    {
      title: "Hollow Knight", genre: "METROIDVANIA", release_year: "2017",
      developer: "Team Cherry", publisher: "Team Cherry",
      cover_url: "https://shared.steamstatic.com/store_item_assets/steam/apps/367520/library_600x900.jpg",
      steam_id: "367520", igdb_id: "19516", rawg_id: "3272", twitch_id: "493096", kick_id: "",
    },
    {
      title: "Hades", genre: "ROGUE-LIKE", release_year: "2020",
      developer: "Supergiant Games", publisher: "Supergiant Games",
      cover_url: "https://shared.steamstatic.com/store_item_assets/steam/apps/1145360/library_600x900.jpg",
      steam_id: "1145360", igdb_id: "12350", rawg_id: "562634", twitch_id: "512980", kick_id: "",
    },
    {
      title: "Vampire Survivors", genre: "SHOOT 'EM UP", release_year: "2022",
      developer: "Poncle", publisher: "Poncle",
      cover_url: "",
      steam_id: "1794680", igdb_id: "", rawg_id: "768205", twitch_id: "", kick_id: "",
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LIBRARY VIEW — orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export default function LibraryView({
  toast,
}: {
  toast: (msg: string, type?: ToastType) => void;
}) {
  const [library, setLibrary] = useState<ForgeLibraryEntry[]>([]);
  const [exiled, setExiled] = useState<ExiledEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showExiled, setShowExiled] = useState(false);
  const [showAddGame, setShowAddGame] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem("sf_viewMode") as ViewMode) || "carousel"; } catch { return "carousel"; }
  });
  const [sortBy, setSortBy] = useState<"title" | "genre" | "year" | "developer">(() => {
    try { return (localStorage.getItem("sf_sortBy") as "title" | "genre" | "year" | "developer") || "title"; } catch { return "title"; }
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try { return (localStorage.getItem("sf_sortDir") as "asc" | "desc") || "asc"; } catch { return "asc"; }
  });

  useEffect(() => { localStorage.setItem("sf_viewMode", viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem("sf_sortBy", sortBy); }, [sortBy]);
  useEffect(() => { localStorage.setItem("sf_sortDir", sortDir); }, [sortDir]);
  const [sortOpen, setSortOpen] = useState(false);

  // Search filter + sort
  const filteredLibrary = useMemo(() => {
    let results = library;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      results = library.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.genre.toLowerCase().includes(q) ||
          e.developer.toLowerCase().includes(q) ||
          e.publisher.toLowerCase().includes(q) ||
          e.release_year.includes(q)
      );
    }
    const sorted = [...results].sort((a, b) => {
      let va: string, vb: string;
      switch (sortBy) {
        case "genre":   va = a.genre || ""; vb = b.genre || ""; break;
        case "year":    va = a.release_year || ""; vb = b.release_year || ""; break;
        case "developer": va = a.developer || ""; vb = b.developer || ""; break;
        default:        va = a.title || ""; vb = b.title || ""; break;
      }
      const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [library, searchQuery, sortBy, sortDir]);

  const gridSelectEntry = useCallback(
    (entry: ForgeLibraryEntry) => {
      const idx = library.findIndex((e) => e.title === entry.title);
      if (idx !== -1) setActiveIndex(idx);
      setShowOverlay(true);
    },
    [library]
  );

  // ── Data loading ──

  const load = useCallback(async () => {
    setLoading(true);
    const token = await fetchWidgetToken();
    try {
      const [forgeRes, exiledRes] = await Promise.all([
        fetch("http://127.0.0.1:53735/api/forge-full", { headers: { "X-Forge-Token": token } }),
        fetch("http://127.0.0.1:53735/api/exiled-apps", { headers: { "X-Forge-Token": token } }),
      ]);
      if (forgeRes.ok) {
        const data = (await forgeRes.json()) as Record<string, ForgeLibraryEntry>;
        const entries = Object.values(data).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        setLibrary(entries.length > 0 ? entries : getDummyLibrary());
      } else {
        setLibrary(getDummyLibrary());
      }
      if (exiledRes.ok) {
        const ex = (await exiledRes.json()) as string[];
        setExiled(ex.map((p) => ({ process: p })));
      }
    } catch {
      setLibrary(getDummyLibrary());
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── API helpers ──

  const saveEntry = async (updated: Partial<ForgeLibraryEntry>) => {
    const token = await fetchWidgetToken();
    try {
      await fetch("http://127.0.0.1:53735/list", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify(updated),
      });
      toast("Saved", "success");
      load();
    } catch { toast("Save failed", "error"); }
  };

  const reinstate = async (proc: string) => {
    const token = await fetchWidgetToken();
    try {
      await fetch("http://127.0.0.1:53735/unexile", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ process: proc }),
      });
      toast(`Reinstated ${proc}`, "success");
      load();
    } catch { toast("Failed to reinstate", "error"); }
  };

  const deleteExiled = async (proc: string) => {
    if (!confirm(`Permanently delete "${proc}" from the database?`)) return;
    const token = await fetchWidgetToken();
    try {
      const metaRes = await fetch("http://127.0.0.1:53735/export-meta", { headers: { "X-Forge-Token": token } });
      if (metaRes.ok) {
        const db = (await metaRes.json()) as {
          delisted_apps: string[];
          listed_apps: Record<string, string>;
          library: Record<string, ForgeLibraryEntry>;
        };
        db.delisted_apps = db.delisted_apps.filter((p) => p !== proc.toLowerCase());
        Object.keys(db.listed_apps).forEach((k) => { if (k === proc.toLowerCase()) delete db.listed_apps[k]; });
        await fetch("http://127.0.0.1:53735/import-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forge-Token": token },
          body: JSON.stringify(db),
        });
        toast(`Deleted ${proc}`, "success");
        load();
      }
    } catch { toast("Delete failed", "error"); }
  };

  const saveBaseMetadata = async (title: string, year: string, dev: string) => {
    const token = await fetchWidgetToken();
    const payload: Record<string, string> = { title };
    if (year) payload["custom_release_year"] = year;
    if (dev) { payload["custom_developer"] = dev; payload["custom_publisher"] = dev; }
    await fetch("http://127.0.0.1:53735/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forge-Token": token },
      body: JSON.stringify(payload),
    });
    load();
  };

  const handleAddGameScan = async (title: string, year: string, dev: string): Promise<ForgeLibraryEntry | null> => {
    try {
      await saveBaseMetadata(title, year, dev);
      const token = await fetchWidgetToken();
      const scanRes = await fetch("http://127.0.0.1:53735/api/scan-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ title }),
      });
      if (scanRes.ok) return (await scanRes.json()) as ForgeLibraryEntry;
      return null;
    } catch { return null; }
  };

  const handleScanMetadata = async (title: string): Promise<ForgeLibraryEntry | null> => {
    const token = await fetchWidgetToken();
    try {
      const scanRes = await fetch("http://127.0.0.1:53735/api/scan-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ title }),
      });
      if (scanRes.ok) return (await scanRes.json()) as ForgeLibraryEntry;
      return null;
    } catch { return null; }
  };

  const activeEntry = library[activeIndex] || null;

  // ── Render ──

  const sortLabel = sortBy === "title" ? "Title" : sortBy === "genre" ? "Genre" : sortBy === "year" ? "Year" : "Developer";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-6 shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">Library</h2>
            <p className="text-white/40 text-sm mt-1">
              {filteredLibrary.length !== library.length
                ? `${filteredLibrary.length} of ${library.length} games`
                : `${library.length} game${library.length !== 1 ? "s" : ""}`}
              {" · "}{exiled.length} exiled
            </p>
          </div>
        </div>

        {/* Unified toolbar: search + sort + view toggle + actions */}
        <div className="toolbar-glass">
          {/* Search */}
          <div className="relative flex-1 min-w-0">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title, genre, developer..."
              className="w-full pl-10 pr-8 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm outline-none placeholder:text-white/28 transition-all focus:bg-white/[0.07] focus:border-purple-500/40 focus:shadow-[0_0_0_3px_rgba(145,70,255,0.08)]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors cursor-pointer bg-white/[0.06] border border-white/[0.06] rounded-md w-4 h-4 flex items-center justify-center text-[10px]"
              >✕</button>
            )}
          </div>

          {/* Divider */}
          <div className="divider-v h-6" />

          {/* Sort */}
          <div className="relative shrink-0">
            <button
              onClick={() => setSortOpen(!sortOpen)}
              className="flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none rounded-lg bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.1]"
              title="Sort by"
            >
              <svg className="w-4 h-4 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ transform: sortDir === "desc" ? "rotate(180deg)" : "rotate(0deg)" }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              <span className="hidden sm:inline">{sortLabel}</span>
            </button>
            {sortOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 surface-glass rounded-xl overflow-hidden min-w-[140px]">
                  {(["title", "genre", "year", "developer"] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => {
                        if (sortBy === opt) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        else { setSortBy(opt); setSortDir("asc"); }
                        setSortOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium transition-colors cursor-pointer border-none ${
                        sortBy === opt ? "bg-[color-mix(in_srgb,var(--user-accent,#9146FF)_20%,transparent)] text-[var(--user-accent,#c084fc)]" : "bg-transparent text-white/60 hover:bg-white/[0.06] hover:text-white/80"
                      }`}
                    >
                      <span>{opt === "title" ? "Title" : opt === "genre" ? "Genre" : opt === "year" ? "Year" : "Developer"}</span>
                      {sortBy === opt && (
                        <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Divider */}
          <div className="divider-v h-6" />

          {/* View toggle */}
          <div className="flex items-center overflow-hidden rounded-lg bg-white/[0.04] border border-white/[0.06]">
            <button
              onClick={() => setViewMode("carousel")}
              className={`px-2.5 py-2 text-xs font-semibold transition-all cursor-pointer rounded-lg ${
                viewMode === "carousel"
                  ? "toggle-active"
                  : "bg-transparent text-white/50 hover:text-white/80 hover:bg-white/[0.04] border-none"
              }`}
              title="Carousel view"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="2" y="6" width="20" height="12" rx="2" strokeWidth={2} />
                <circle cx="6" cy="12" r="1.5" fill="currentColor" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                <circle cx="18" cy="12" r="1.5" fill="currentColor" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`px-2.5 py-2 text-xs font-semibold transition-all cursor-pointer rounded-lg ${
                viewMode === "grid"
                  ? "toggle-active"
                  : "bg-transparent text-white/50 hover:text-white/80 hover:bg-white/[0.04] border-none"
              }`}
              title="Grid view"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
          </div>

          {/* Divider */}
          <div className="divider-v h-6" />

          {/* Action buttons */}
          <div className="flex items-center overflow-hidden rounded-lg bg-white/[0.04] border border-white/[0.06]">
            <button
              onClick={() => setShowAddGame(true)}
              className="px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none bg-transparent hover:bg-white/[0.06] active:bg-white/[0.1]"
              title="Add Game"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button
              onClick={() => setShowExiled(true)}
              className="px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none bg-transparent hover:bg-white/[0.06] active:bg-white/[0.1]"
              title="Exiled Apps"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent" }}>
        {loading ? (
          <Card><p className="text-white/40">Loading library...</p></Card>
        ) : viewMode === "carousel" ? (
          <div className="flex items-center justify-center h-full">
            <CarouselView
              entries={filteredLibrary}
              activeIndex={Math.min(activeIndex, Math.max(0, filteredLibrary.length - 1))}
              onSelect={setActiveIndex}
              onActiveCardClick={() => setShowOverlay(true)}
            />
          </div>
        ) : (
          <GridView entries={filteredLibrary} onSelect={gridSelectEntry} />
        )}
      </div>

      {/* Overlays */}
      {showOverlay && activeEntry && (
        <MetadataOverlay entry={activeEntry} onSave={saveEntry} onScan={handleScanMetadata} onClose={() => setShowOverlay(false)} />
      )}
      {showExiled && (
        <ExiledPanel exiled={exiled} onReinstate={reinstate} onDelete={deleteExiled} onClose={() => setShowExiled(false)} />
      )}
      {showAddGame && (
        <AddGamePanel onScan={handleAddGameScan} onSaveBase={saveBaseMetadata} onClose={() => setShowAddGame(false)} toast={toast} />
      )}
    </div>
  );
}
