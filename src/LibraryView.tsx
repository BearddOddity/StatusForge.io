import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ForgeDatabase, ForgeLibraryEntry, ToastType } from "@statusforge/types";
import { fetchOverlayToken, tauriApi } from "@statusforge/hooks/useTauriApi";
import { Card } from "@statusforge/components/ui";
import CarouselView from "@statusforge/components/CarouselView";
import GridView from "@statusforge/components/GridView";
import {
  OverlayMetadataPanel,
  ExiledManagerPanel,
  AddGameOverlayPanel,
} from "@statusforge/components/Overlays";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ExiledEntry {
  process: string;
}

type ViewMode = "carousel" | "grid";

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LIBRARY VIEW — orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export default function LibraryView({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  const [library, setLibrary] = useState<ForgeLibraryEntry[]>([]);
  const [exiled, setExiled] = useState<ExiledEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showExiled, setShowExiled] = useState(false);
  const [showAddGame, setShowAddGame] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem("sf_viewMode") as ViewMode) || "carousel";
    } catch {
      return "carousel";
    }
  });
  const [sortBy, setSortBy] = useState<"title" | "genre" | "year" | "developer">(() => {
    try {
      return (
        (localStorage.getItem("sf_sortBy") as "title" | "genre" | "year" | "developer") || "title"
      );
    } catch {
      return "title";
    }
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try {
      return (localStorage.getItem("sf_sortDir") as "asc" | "desc") || "asc";
    } catch {
      return "asc";
    }
  });

  useEffect(() => {
    localStorage.setItem("sf_viewMode", viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem("sf_sortBy", sortBy);
  }, [sortBy]);
  useEffect(() => {
    localStorage.setItem("sf_sortDir", sortDir);
  }, [sortDir]);
  const [sortOpen, setSortOpen] = useState(false);
  const sortBtnRef = useRef<HTMLDivElement>(null);
  const [sortMenuPos, setSortMenuPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (sortOpen && sortBtnRef.current) {
      const rect = sortBtnRef.current.getBoundingClientRect();
      setSortMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
  }, [sortOpen]);

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
        case "genre":
          va = a.genre || "";
          vb = b.genre || "";
          break;
        case "year":
          va = a.release_year || "";
          vb = b.release_year || "";
          break;
        case "developer":
          va = a.developer || "";
          vb = b.developer || "";
          break;
        default:
          va = a.title || "";
          vb = b.title || "";
          break;
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
    const token = await fetchOverlayToken();
    try {
      const [forgeRes, exiledRes, settingsRes] = await Promise.all([
        fetch("http://127.0.0.1:53735/api/forge-full", { headers: { "X-Forge-Token": token } }),
        fetch("http://127.0.0.1:53735/api/exiled-apps", { headers: { "X-Forge-Token": token } }),
        fetch("http://127.0.0.1:53735/settings", { headers: { "X-Forge-Token": token } }),
      ]);
      if (forgeRes.ok) {
        const data = (await forgeRes.json()) as Record<string, ForgeLibraryEntry>;
        // The idle category (e.g. "Just Chatting") gets a Library entry so its
        // cover is editable, but it isn't a game — keep it out of the browsing
        // grid/carousel.
        let idleCategory = "";
        if (settingsRes.ok) {
          const s = (await settingsRes.json()) as { idle_category?: string };
          idleCategory = (s.idle_category || "").trim().toLowerCase();
        }
        const entries = Object.values(data)
          .filter((e) => e.title.trim().toLowerCase() !== idleCategory)
          .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        setLibrary(entries);
      } else {
        setLibrary([]);
        toast("Couldn't load your library — is the engine running?", "error");
      }
      if (exiledRes.ok) {
        const ex = (await exiledRes.json()) as string[];
        setExiled(ex.map((p) => ({ process: p })));
      }
    } catch {
      setLibrary([]);
      toast("Couldn't reach the engine — is it running?", "error");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // ── API helpers ──

  // A pasted cover/logo can be a direct image URL, a local file path, or a
  // SteamGridDB page link (e.g. steamgriddb.com/grid/805055) — resolve the
  // page link to its real image URL before saving so it always renders.
  const resolveCoverFields = async (
    updated: Partial<ForgeLibraryEntry>
  ): Promise<Partial<ForgeLibraryEntry> | null> => {
    const resolved = { ...updated };
    for (const key of ["cover_url", "logo_url"] as const) {
      const value = resolved[key];
      if (!value) continue;
      const token = await fetchOverlayToken();
      const res = await fetch("http://127.0.0.1:53735/api/resolve-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ url: value }),
      });
      if (!res.ok) {
        const message = await res.text().catch(() => "");
        toast(message || `Couldn't resolve ${key === "cover_url" ? "Cover" : "Logo"} URL`, "error");
        return null;
      }
      const body = (await res.json()) as { url: string };
      resolved[key] = body.url;
    }
    return resolved;
  };

  const saveEntry = async (updated: Partial<ForgeLibraryEntry>) => {
    const resolved = await resolveCoverFields(updated);
    if (!resolved) return;
    const token = await fetchOverlayToken();
    try {
      await fetch("http://127.0.0.1:53735/list", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify(resolved),
      });
      toast("Saved", "success");
      load();
    } catch {
      toast("Save failed", "error");
    }
  };

  const exportEntry = async (title: string) => {
    const res = await tauriApi("export_single_game_metadata", { title });
    if (typeof res === "string") {
      toast(`"${title}" exported to ${res}`, "success");
    } else {
      const err =
        res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
      toast(err ? `Export failed: ${err}` : "Export failed", "error");
    }
  };

  // Reads the picked file as plain text in the browser sandbox (no backend
  // path access — the OS file dialog is the only thing that chose this
  // file), then hands the raw JSON to the backend. import_single_game_metadata
  // does the actual validation/merge; a bad or hostile file can only fail to
  // parse or fill in blanks, never overwrite what's already in the library.
  const importMetadataFile = async (file: File) => {
    let json: string;
    try {
      json = await file.text();
    } catch {
      toast("Couldn't read that file", "error");
      return;
    }
    const res = await tauriApi("import_single_game_metadata", { json });
    if (typeof res === "string") {
      toast(res, "success");
      load();
    } else {
      const err =
        res && typeof res === "object" && "error" in res ? (res as { error: string }).error : "";
      toast(err ? `Import failed: ${err}` : "Import failed", "error");
    }
  };

  const reinstate = async (proc: string) => {
    const token = await fetchOverlayToken();
    try {
      await fetch("http://127.0.0.1:53735/unexile", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ process: proc }),
      });
      toast(`Reinstated ${proc}`, "success");
      load();
    } catch {
      toast("Failed to reinstate", "error");
    }
  };

  const deleteExiled = async (proc: string) => {
    if (!confirm(`Permanently delete "${proc}" from the database?`)) return;
    const token = await fetchOverlayToken();
    try {
      const metaRes = await fetch("http://127.0.0.1:53735/export-meta", {
        headers: { "X-Forge-Token": token },
      });
      if (metaRes.ok) {
        const db = (await metaRes.json()) as {
          delisted_apps: string[];
          listed_apps: Record<string, string>;
          library: Record<string, ForgeLibraryEntry>;
        };
        db.delisted_apps = db.delisted_apps.filter((p) => p !== proc.toLowerCase());
        Object.keys(db.listed_apps).forEach((k) => {
          if (k === proc.toLowerCase()) delete db.listed_apps[k];
        });
        await fetch("http://127.0.0.1:53735/import-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forge-Token": token },
          body: JSON.stringify(db),
        });
        toast(`Deleted ${proc}`, "success");
        load();
      }
    } catch {
      toast("Delete failed", "error");
    }
  };

  const handleExile = async (title: string) => {
    const token = await fetchOverlayToken();
    try {
      const metaRes = await fetch("http://127.0.0.1:53735/export-meta", {
        headers: { "X-Forge-Token": token },
      });
      if (metaRes.ok) {
        const db = (await metaRes.json()) as ForgeDatabase;
        delete db.library[title];
        if (!db.delisted_apps.includes(title.toLowerCase())) {
          db.delisted_apps.push(title.toLowerCase());
        }
        await fetch("http://127.0.0.1:53735/import-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forge-Token": token },
          body: JSON.stringify(db),
        });
        toast(`Exiled "${title}"`, "success");
        setShowOverlay(false);
        load();
      }
    } catch {
      toast("Exile failed", "error");
    }
  };

  const saveBaseMetadata = async (title: string, year: string, dev: string) => {
    const token = await fetchOverlayToken();
    const payload: Record<string, string> = { title };
    if (year) payload["custom_release_year"] = year;
    if (dev) {
      payload["custom_developer"] = dev;
      payload["custom_publisher"] = dev;
    }
    await fetch("http://127.0.0.1:53735/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forge-Token": token },
      body: JSON.stringify(payload),
    });
    load();
  };

  const handleAddGameScan = async (
    title: string,
    year: string,
    dev: string
  ): Promise<ForgeLibraryEntry | null> => {
    try {
      await saveBaseMetadata(title, year, dev);
      const token = await fetchOverlayToken();
      const scanRes = await fetch("http://127.0.0.1:53735/api/scan-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ title }),
      });
      if (scanRes.ok) return (await scanRes.json()) as ForgeLibraryEntry;
      return null;
    } catch {
      return null;
    }
  };

  const handleScanMetadata = async (title: string): Promise<ForgeLibraryEntry | null> => {
    const token = await fetchOverlayToken();
    try {
      const scanRes = await fetch("http://127.0.0.1:53735/api/scan-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forge-Token": token },
        body: JSON.stringify({ title }),
      });
      if (scanRes.ok) return (await scanRes.json()) as ForgeLibraryEntry;
      return null;
    } catch {
      return null;
    }
  };

  const activeEntry = library[activeIndex] || null;

  // ── Render ──

  const sortLabel =
    sortBy === "title"
      ? "Title"
      : sortBy === "genre"
        ? "Genre"
        : sortBy === "year"
          ? "Year"
          : "Developer";

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
              {" · "}
              {exiled.length} exiled
            </p>
          </div>
        </div>

        {/* Unified toolbar: search + sort + view toggle + actions */}
        <div className="toolbar-glass">
          {/* Search */}
          <div className="relative flex-1 min-w-0">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
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
              >
                ✕
              </button>
            )}
          </div>

          {/* Divider */}
          <div className="divider-v h-6" />

          {/* Sort */}
          <div className="relative shrink-0" ref={sortBtnRef}>
            <button
              onClick={() => setSortOpen(!sortOpen)}
              className="flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none rounded-lg bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.1]"
              title="Sort by"
            >
              <svg
                className="w-4 h-4 transition-transform duration-200"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ transform: sortDir === "desc" ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
                />
              </svg>
              <span className="hidden sm:inline">{sortLabel}</span>
            </button>
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
            <button
              onClick={() => setShowExiled(true)}
              className="px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none bg-transparent hover:bg-white/[0.06] active:bg-white/[0.1]"
              title="Exiled Apps"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                />
              </svg>
            </button>
            <label
              className="px-2.5 py-2 text-xs font-semibold text-white/50 hover:text-white/80 active:text-white transition-all cursor-pointer border-none bg-transparent hover:bg-white/[0.06] active:bg-white/[0.1] flex items-center"
              title="Import Game Metadata (.json)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                />
              </svg>
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importMetadataFile(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Content */}
      <div
        className="flex-1 min-h-0"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent" }}
      >
        {loading ? (
          <Card>
            <p className="text-white/40">Loading library...</p>
          </Card>
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
        <OverlayMetadataPanel
          entry={activeEntry}
          isOpen={showOverlay}
          onClose={() => setShowOverlay(false)}
          onSave={saveEntry}
          onSearchApis={async () =>
            (await handleScanMetadata(activeEntry.title)) as Record<string, string> | null
          }
          onExile={handleExile}
          onExportEntry={exportEntry}
          saving={false}
        />
      )}
      {showExiled && (
        <ExiledManagerPanel
          open={showExiled}
          onClose={() => setShowExiled(false)}
          exiled={exiled}
          onReinstate={reinstate}
          onDelete={deleteExiled}
        />
      )}
      {showAddGame && (
        <AddGameOverlayPanel
          open={showAddGame}
          onClose={() => setShowAddGame(false)}
          onAdd={(entry) => saveEntry(entry)}
          onSearch={handleAddGameScan}
          gameCategories={[]}
          libraryGenres={[]}
          onImportGame={importMetadataFile}
        />
      )}

      {/* Sort dropdown — portaled to body to escape stacking contexts */}
      {sortOpen &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[100]" onClick={() => setSortOpen(false)} />
            <div
              className="fixed z-[101] surface-glass rounded-xl overflow-hidden min-w-[140px]"
              style={{ top: sortMenuPos.top, right: sortMenuPos.right }}
            >
              {(["title", "genre", "year", "developer"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    if (sortBy === opt) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortBy(opt);
                      setSortDir("asc");
                    }
                    setSortOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium transition-colors cursor-pointer border-none ${
                    sortBy === opt
                      ? "bg-[color-mix(in_srgb,var(--user-accent,#9146FF)_20%,transparent)] text-[var(--user-accent,#c084fc)]"
                      : "bg-transparent text-white/60 hover:bg-white/[0.06] hover:text-white/80"
                  }`}
                >
                  <span>
                    {opt === "title"
                      ? "Title"
                      : opt === "genre"
                        ? "Genre"
                        : opt === "year"
                          ? "Year"
                          : "Developer"}
                  </span>
                  {sortBy === opt && (
                    <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
