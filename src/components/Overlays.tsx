import { useState, useEffect, useRef } from "react";
import { type ExiledApp } from "@statusforge/types";
import { Btn, MetadataField, CoverImage, FieldSection } from "./ui";
import { resolveImageSrc } from "@statusforge/utils/imageSrc";

// ═══════════════════════════════════════════════════════════════════════════════
// OverlayMetadataPanel — right-slide metadata editor
// ═══════════════════════════════════════════════════════════════════════════════

interface OverlayMetadataPanelProps {
  entry:
    | {
        title: string;
        genre: string;
        release_year: string;
        developer: string;
        publisher: string;
        cover_url: string;
        logo_url: string;
        executables: string;
        steam_id: string;
        igdb_id: string;
        rawg_id: string;
        sgdb_id: string;
        gog_id: string;
        thegamesdb_id: string;
        twitch_id: string;
        kick_id: string;
        aliases?: { name: string }[];
      }
    | undefined;
  isOpen: boolean;
  onClose: () => void;
  onSave: (entry: Record<string, string>) => void;
  onSearchApis: (field: string, query: string) => Promise<Record<string, string> | null>;
  onExile?: (title: string) => void;
  onExportEntry?: (title: string) => void;
  saving: boolean;
}

const FIELD_SECTIONS = [
  {
    title: "Basic Info",
    icon: "📝",
    fields: [
      { key: "title", label: "Title" },
      { key: "genre", label: "Genre" },
      { key: "release_year", label: "Release Year" },
      { key: "developer", label: "Developer" },
      { key: "publisher", label: "Publisher" },
      {
        key: "executables",
        label: "File Name(s)",
        placeholder: "e.g. FalloutNV.exe",
        hint: "The exact .exe the scanner should match to this title (comma-separate more than one, full paths are fine too — only the file name is used). Fixes a game that's detected under the wrong name or not detected at all.",
      },
      {
        key: "aliases",
        label: "Detection Aliases",
        placeholder: "e.g. DS3, Dark Souls 3",
        hint: "Other names that should resolve to this game — abbreviations, other languages, odd window titles. Comma-separate multiple; matching ignores case.",
      },
    ],
  },
  {
    title: "Cover",
    icon: "🖼️",
    fields: [
      {
        key: "cover_url",
        label: "Cover URL",
        hint: "A direct image link, a local file path, or a SteamGridDB page link (e.g. steamgriddb.com/grid/12345).",
      },
      {
        key: "logo_url",
        label: "Logo URL",
        hint: "A direct image link, a local file path, or a SteamGridDB page link (e.g. steamgriddb.com/logo/12345).",
      },
    ],
  },
  {
    title: "External IDs",
    icon: "🔗",
    fields: [
      { key: "steam_id", label: "Steam" },
      { key: "igdb_id", label: "IGDB" },
      { key: "rawg_id", label: "RAWG" },
      { key: "sgdb_id", label: "SteamGridDB" },
      { key: "gog_id", label: "GOG" },
      { key: "thegamesdb_id", label: "TheGamesDB" },
      { key: "twitch_id", label: "Twitch" },
      { key: "kick_id", label: "Kick" },
    ],
  },
];

export function OverlayMetadataPanel({
  entry,
  isOpen,
  onClose,
  onSave,
  onSearchApis,
  onExile,
  onExportEntry,
  saving,
}: OverlayMetadataPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [editData, setEditData] = useState<Record<string, string>>({});
  const [previewTab, setPreviewTab] = useState<"cover" | "logo">("cover");

  useEffect(() => {
    if (entry) {
      setEditData({
        title: entry.title || "",
        genre: entry.genre || "",
        release_year: entry.release_year || "",
        developer: entry.developer || "",
        publisher: entry.publisher || "",
        cover_url: entry.cover_url || "",
        logo_url: entry.logo_url || "",
        executables: entry.executables || "",
        aliases: (entry.aliases || []).map((a) => a.name).join(", "),
        steam_id: entry.steam_id || "",
        igdb_id: entry.igdb_id || "",
        rawg_id: entry.rawg_id || "",
        sgdb_id: entry.sgdb_id || "",
        gog_id: entry.gog_id || "",
        thegamesdb_id: entry.thegamesdb_id || "",
        twitch_id: entry.twitch_id || "",
        kick_id: entry.kick_id || "",
      });
      setPreviewTab("cover");
    }
  }, [entry]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  // The underlying scan is always a whole-title lookup across every source
  // (Steam/GOG/RAWG/IGDB/SteamGridDB) — there's no way to ask an API for
  // "just the genre" — but a single field's search button should still only
  // touch that one field, for users who want to pull in one piece of info
  // without overwriting everything else they've already got set/edited.
  // Passing no `field` (the sidebar "Scan Metadata" button) applies all of it.
  const runScan = async (field?: string) => {
    if (!entry?.title) return;
    const result = await onSearchApis(field || "", entry.title);
    if (!result) return;
    if (field) {
      const value = result[field];
      if (value) {
        setEditData((prev) => ({ ...prev, [field]: value }));
      }
    } else {
      setEditData((prev) => ({ ...prev, ...result }));
    }
  };

  if (!isOpen || !entry) return null;

  const typedData = editData as Record<string, string>;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={panelRef}
        className="modal-panel w-[90vw] max-w-[1100px] max-h-[85vh] flex overflow-hidden"
      >
        {/* Left sidebar — cover + actions */}
        <div className="w-[280px] shrink-0 bg-black/20 border-r border-white/5 p-4 overflow-y-auto flex flex-col">
          <div className="relative flex flex-col items-center mb-5">
            <div className="flex w-full mb-2 rounded-lg bg-white/[0.04] border border-white/10 p-0.5">
              <button
                onClick={() => setPreviewTab("cover")}
                className={`flex-1 text-[11px] font-medium py-1.5 rounded-md transition-all cursor-pointer ${
                  previewTab === "cover"
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                Cover
              </button>
              <button
                onClick={() => setPreviewTab("logo")}
                className={`flex-1 text-[11px] font-medium py-1.5 rounded-md transition-all cursor-pointer ${
                  previewTab === "logo"
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                Logo
              </button>
            </div>
            {previewTab === "cover" ? (
              <div className="w-full aspect-[2/3] rounded-2xl overflow-hidden bg-black/30 border border-white/10 shadow-lg shadow-black/30 hover:border-white/15 transition-all">
                <CoverImage src={editData.cover_url || ""} alt={editData.title || ""} />
              </div>
            ) : (
              <div className="w-full aspect-[2/3] rounded-2xl overflow-hidden bg-black/30 border border-white/10 shadow-lg shadow-black/30 hover:border-white/15 transition-all flex items-center justify-center p-4">
                {editData.logo_url ? (
                  <img
                    src={resolveImageSrc(editData.logo_url)}
                    alt={`${editData.title || ""} logo`}
                    className="max-w-full max-h-full object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="text-white/25 text-xs text-center px-4">No logo URL set</span>
                )}
              </div>
            )}
            <h3 className="text-white font-semibold text-center mt-3 text-sm">
              {entry.title || "Untitled"}
            </h3>
          </div>

          <Btn
            variant="ghost"
            onClick={() => onSave(editData)}
            disabled={saving}
            className="w-full justify-center"
          >
            {saving ? "Saving..." : "💾 Save Changes"}
          </Btn>
          <Btn variant="ghost" onClick={() => runScan()} className="w-full justify-center mt-2">
            🔍 Scan Metadata
          </Btn>
          {onExportEntry && entry.title && (
            <Btn
              variant="ghost"
              onClick={() => onExportEntry(entry.title)}
              className="w-full justify-center mt-2"
            >
              📤 Export This Game
            </Btn>
          )}
          {onExile && (
            <Btn
              variant="danger"
              onClick={() => {
                if (
                  entry.title &&
                  confirm(
                    `Exile "${entry.title}"? This will remove it from the library and prevent it from being re-detected by the scanner.`
                  )
                ) {
                  onExile(entry.title);
                }
              }}
              className="w-full justify-center mt-2"
            >
              🚫 Exile
            </Btn>
          )}
        </div>

        {/* Right panel — header + scrollable sections */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
            <p className="text-white/50 text-xs font-semibold uppercase tracking-wider">
              Edit Metadata
            </p>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-all cursor-pointer text-sm"
            >
              ✕
            </button>
          </div>

          <div
            className="flex-1 overflow-y-auto p-5"
            style={{
              scrollbarWidth: "thin",
              scrollbarColor: "rgba(255,255,255,0.15) transparent",
            }}
          >
            {FIELD_SECTIONS.map((section) => (
              <FieldSection
                key={section.title}
                title={section.title}
                icon={section.icon}
                defaultOpen={section.title === "Basic Info"}
              >
                <div className="grid grid-cols-2 gap-x-6 gap-y-0">
                  {section.fields.map((field) => (
                    <MetadataField
                      key={field.key}
                      label={field.label}
                      value={typedData[field.key] || ""}
                      saving={saving}
                      onChange={(val) =>
                        setEditData((prev) => ({
                          ...prev,
                          [field.key]: val,
                        }))
                      }
                      onSave={(val) =>
                        onSave(
                          field.key === "title"
                            ? { old_title: entry?.title ?? editData.title, title: val }
                            : ({ title: editData.title, [field.key]: val } as Record<string, string>)
                        )
                      }
                      onSearch={
                        field.key !== "title" &&
                        field.key !== "executables" &&
                        field.key !== "aliases" &&
                        entry.title
                          ? () => runScan(field.key)
                          : undefined
                      }
                      placeholder={"placeholder" in field ? field.placeholder : undefined}
                      hint={"hint" in field ? field.hint : undefined}
                    />
                  ))}
                </div>
              </FieldSection>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ExiledManagerPanel — manage exiled apps
// ═══════════════════════════════════════════════════════════════════════════════

export function ExiledManagerPanel({
  open,
  onClose,
  exiled,
  onReinstate,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  exiled: ExiledApp[];
  onReinstate: (process: string) => void;
  onDelete: (process: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div ref={panelRef} className="modal-panel w-[90vw] max-w-[420px] max-h-[70vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-xs">
              🚫
            </span>
            <h3 className="text-white font-semibold text-sm">Exiled Applications</h3>
          </div>
          <Btn variant="ghost" onClick={onClose}>
            ✕
          </Btn>
        </div>
        <div
          className="flex-1 overflow-y-auto p-4"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.15) transparent",
          }}
        >
          {exiled.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-white/25">
              <span className="text-2xl mb-2">🛡️</span>
              <p className="text-sm">No exiled applications</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {exiled.map((item) => (
                <div
                  key={item.process}
                  className="flex items-center justify-between bg-white/[0.02] border border-white/[0.06] rounded-xl px-4 py-3"
                >
                  <span className="font-mono text-sm text-white/70 truncate flex-1 mr-3">
                    {item.process}
                  </span>
                  <div className="flex gap-1.5 shrink-0">
                    <Btn variant="success" onClick={() => onReinstate(item.process)}>
                      ✓ Reinstate
                    </Btn>
                    <Btn variant="danger" onClick={() => onDelete(item.process)}>
                      🗑 Delete
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AddGameOverlayPanel — manual game entry form
// ═══════════════════════════════════════════════════════════════════════════════

interface AddGameOverlayPanelProps {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: {
    title: string;
    genre: string;
    release_year: string;
    developer: string;
    publisher: string;
    cover_url: string;
    steam_id: string;
    igdb_id: string;
    rawg_id: string;
    sgdb_id: string;
    gog_id: string;
    thegamesdb_id: string;
    twitch_id: string;
    kick_id: string;
  }) => void;
  onSearch: (
    title: string,
    year: string,
    dev: string
  ) => Promise<{
    title?: string;
    genre?: string;
    release_year?: string;
    developer?: string;
    publisher?: string;
    cover_url?: string;
    steam_id?: string;
    igdb_id?: string;
    rawg_id?: string;
    sgdb_id?: string;
    gog_id?: string;
    thegamesdb_id?: string;
    twitch_id?: string;
    kick_id?: string;
  } | null>;
  gameCategories: string[];
  libraryGenres: string[];
  /// Imports a single *_metadata.json file (community-shared or a signed
  /// "verified official" export) straight into the library, bypassing this
  /// form entirely — the file already has everything a manual entry would
  /// ask for.
  onImportGame: (file: File) => void;
}

export function AddGameOverlayPanel({
  open,
  onClose,
  onAdd,
  onSearch,
  gameCategories,
  libraryGenres,
  onImportGame,
}: AddGameOverlayPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [dev, setDev] = useState("");
  const [genre, setGenre] = useState("");
  const [cover, setCover] = useState("");
  const [result, setResult] = useState<Record<string, string> | null>(null);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  useEffect(() => {
    if (!open) {
      setTitle("");
      setYear("");
      setDev("");
      setGenre("");
      setCover("");
      setResult(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSearch = async () => {
    if (!title.trim()) return;
    const res = await onSearch(title, year, dev);
    if (res) setResult(res);
  };

  const handleSubmit = () => {
    const src = result || {
      title,
      genre,
      release_year: year,
      developer: dev,
      publisher: dev,
      cover_url: cover,
    };
    onAdd({
      title: src.title || title,
      genre: src.genre || genre,
      release_year: src.release_year || year,
      developer: src.developer || dev || "",
      publisher: src.publisher || dev || "",
      cover_url: src.cover_url || cover,
      steam_id: src.steam_id || "",
      igdb_id: src.igdb_id || "",
      rawg_id: src.rawg_id || "",
      sgdb_id: src.sgdb_id || "",
      gog_id: src.gog_id || "",
      thegamesdb_id: src.thegamesdb_id || "",
      twitch_id: src.twitch_id || "",
      kick_id: src.kick_id || "",
    });
  };

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div ref={panelRef} className="modal-panel w-[90vw] max-w-[480px] max-h-[85vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xs">
              ➕
            </span>
            <h3 className="text-white font-semibold text-sm">Add New Game</h3>
          </div>
          <Btn variant="ghost" onClick={onClose}>
            ✕
          </Btn>
        </div>
        <div
          className="flex-1 overflow-y-auto p-5"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.15) transparent",
          }}
        >
          <div className="mb-4">
            <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
              Game Title *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter game title..."
              className="input-glass"
              autoFocus
            />
          </div>
          <div className="mb-4">
            <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
              Release Year
            </label>
            <input
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="e.g. 2024"
              className="input-glass"
            />
          </div>
          <div className="mb-4">
            <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
              Developer / Publisher
            </label>
            <input
              value={dev}
              onChange={(e) => setDev(e.target.value)}
              placeholder="Developer or publisher name..."
              className="input-glass"
            />
          </div>
          <div className="mb-4">
            <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
              Genre
            </label>
            <input
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder="e.g. Action, RPG..."
              className="input-glass"
              list="genre-suggestions"
            />
            <datalist id="genre-suggestions">
              {[...new Set([...gameCategories, ...libraryGenres])].sort().map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div className="mb-4">
            <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
              Cover URL
            </label>
            <input
              value={cover}
              onChange={(e) => setCover(e.target.value)}
              placeholder="https://..."
              className="input-glass"
            />
          </div>

          {result && (
            <div className="mt-5 bg-white/[0.02] border border-white/[0.08] rounded-xl p-4">
              <h4 className="text-white font-semibold text-sm mb-3">Scan Results</h4>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(result).map(([k, v]) => (
                  <div key={k} className="data-row">
                    <span className="data-row-label">{k.replace(/_/g, " ")}</span>
                    <span className="data-row-value">{v || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="p-5 pb-5 border-t border-white/[0.06] flex gap-2 shrink-0">
          <Btn onClick={handleSearch} disabled={!title.trim()} className="flex-1 justify-center">
            🔍 Search APIs
          </Btn>
          <label className="px-4 py-2 rounded-xl text-[11px] font-semibold whitespace-nowrap transition-all duration-200 cursor-pointer border bg-transparent border-white/[0.06] text-white/45 hover:bg-white/[0.04] hover:border-white/10 hover:text-white/70 flex-1 flex items-center justify-center gap-1">
            📥 Import Game
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  onImportGame(file);
                  onClose();
                }
                e.target.value = "";
              }}
            />
          </label>
          <Btn variant="success" onClick={handleSubmit} className="flex-1 justify-center">
            ➕ Add Game
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  );
}
