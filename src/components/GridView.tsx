import type { ForgeLibraryEntry } from "@statusforge/types";
import { useRef, useCallback, type MouseEvent } from "react";
import { Card, CoverImage } from "./ui";

// ═══════════════════════════════════════════════════════════════════════════════
// GridView — Pokémon binder style
// ═══════════════════════════════════════════════════════════════════════════════
// Research applied:
//   • min() + minmax() pattern (responsive-design-notes §1)
//   • content-visibility: auto (performance.md §1)
//   • Container queries for card internals (container-queries.md §2)
//   • aspect-ratio prevents CLS (performance.md §4)

export default function GridView({
  entries,
  onSelect,
}: {
  entries: ForgeLibraryEntry[];
  onSelect: (entry: ForgeLibraryEntry) => void;
}) {
  if (entries.length === 0) {
    return (
      <Card>
        <p className="text-white/40 text-center py-12">No games match your search.</p>
      </Card>
    );
  }

  return (
    <div className="grid-view-container">
      <div className="grid-view-grid">
        {entries.map((entry) => (
          <GridCard key={entry.title} entry={entry} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function GridCard({
  entry,
  onSelect,
}: {
  entry: ForgeLibraryEntry;
  onSelect: (entry: ForgeLibraryEntry) => void;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    tiltRef.current = {
      x: (y - 0.5) * -20,
      y: (x - 0.5) * 20,
    };
    const el = innerRef.current;
    if (el) {
      el.style.transform = `rotateX(${tiltRef.current.x}deg) rotateY(${tiltRef.current.y}deg) scale(1.07)`;
      el.style.border = "1px solid rgba(145, 70, 255, 0.35)";
      el.style.boxShadow = `0 25px 60px rgba(0,0,0,0.65), 0 0 40px rgba(145,70,255,0.2), ${tiltRef.current.y * -3}px ${tiltRef.current.x * 3}px 25px rgba(0,0,0,0.35)`;
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    tiltRef.current = { x: 0, y: 0 };
    const el = innerRef.current;
    if (el) {
      el.style.transform = "scale(1)";
      el.style.border = "1px solid rgba(255, 255, 255, 0.05)";
      el.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    }
  }, []);

  return (
    <div
      className="group relative cursor-pointer grid-view-card-3d"
      onClick={() => onSelect(entry)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        perspective: 600,
        padding: 10,
        margin: -10,
        boxSizing: "content-box",
      }}
    >
      {/* 3D inner — the visual card that rotates (border + cover move together) */}
      <div
        ref={innerRef}
        className="w-full h-full rounded-xl"
        style={{
          transition:
            "transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), border 0.3s, box-shadow 0.3s",
          transformStyle: "preserve-3d",
          background: "rgba(0, 0, 0, 0.25)",
          border: "1px solid rgba(255, 255, 255, 0.05)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        }}
      >
        {/* Cover art — 2:3 ratio */}
        <div className="grid-view-cover">
          <CoverImage src={entry.cover_url} alt={entry.title} lazy />
          <div className="grid-view-glint" />
          <div className="grid-view-gradient" />
        </div>

        {/* Title plate */}
        <div className="grid-view-title">
          <p className="text-white text-[11px] font-bold truncate leading-tight drop-shadow-lg">
            {entry.title}
          </p>
          {entry.release_year && (
            <p className="text-white/40 text-[9px] font-medium mt-px">{entry.release_year}</p>
          )}
        </div>

        {/* Genre badge — visible via container query */}
        {entry.genre && (
          <div className="grid-view-genre-badge">
            <span className="text-[9px] font-semibold tracking-wider text-purple-300/80">
              {entry.genre.charAt(0).toUpperCase() + entry.genre.slice(1).toLowerCase()}
            </span>
          </div>
        )}

        {/* Hover holo border */}
        <div className="grid-view-holo" />
      </div>
    </div>
  );
}
