import type { ForgeLibraryEntry } from "@/types";
import { useState, useRef, useCallback, type MouseEvent } from "react";
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
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setTilt({
      x: (y - 0.5) * -20,
      y: (x - 0.5) * 20,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTilt({ x: 0, y: 0 });
  }, []);

  const isHovered = tilt.x !== 0 || tilt.y !== 0;

  return (
    <div
      ref={cardRef}
      className="group relative cursor-pointer grid-view-card-3d"
      onClick={() => onSelect(entry)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        perspective: 600,
        zIndex: isHovered ? 10 : 0,
        transition: "z-index 0s",
        padding: 10,
        margin: -10,
        boxSizing: "content-box",
      }}
    >
      {/* 3D inner — the visual card that rotates (border + cover move together) */}
      <div
        className="w-full h-full rounded-xl"
        style={{
          transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${isHovered ? 1.07 : 1})`,
          transition: "transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          transformStyle: "preserve-3d",
          background: "rgba(0, 0, 0, 0.25)",
          border: isHovered ? "1px solid rgba(145, 70, 255, 0.35)" : "1px solid rgba(255, 255, 255, 0.05)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: isHovered
            ? `0 25px 60px rgba(0,0,0,0.65), 0 0 40px rgba(145,70,255,0.2), ${tilt.y * -3}px ${tilt.x * 3}px 25px rgba(0,0,0,0.35)`
            : "0 4px 12px rgba(0,0,0,0.2)",
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
          <p className="text-white text-[11px] font-bold truncate leading-tight drop-shadow-lg">{entry.title}</p>
          {entry.release_year && <p className="text-white/40 text-[9px] font-medium mt-px">{entry.release_year}</p>}
        </div>

        {/* Genre badge — visible via container query */}
        {entry.genre && (
          <div className="grid-view-genre-badge">
            <span className="text-[9px] font-semibold tracking-wider text-purple-300/80">{entry.genre.charAt(0).toUpperCase() + entry.genre.slice(1).toLowerCase()}</span>
          </div>
        )}

        {/* Hover holo border */}
        <div className="grid-view-holo" />
      </div>
    </div>
  );
}
