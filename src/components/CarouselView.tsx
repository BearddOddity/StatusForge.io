import { useCallback, useEffect, useRef } from "react";
import type { ForgeLibraryEntry } from "@statusforge/types";
import { Card, CoverImage } from "./ui";

const CARD_WIDTH = 280;
const CARD_HEIGHT = 400;
const CARD_GAP = 40;
const CAROUSEL_WINDOW = 20;

export default function CarouselView({
  entries,
  activeIndex,
  onSelect,
  onActiveCardClick,
}: {
  entries: ForgeLibraryEntry[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onActiveCardClick?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const goTo = useCallback(
    (index: number) => {
      onSelect(((index % entries.length) + entries.length) % entries.length);
    },
    [entries.length, onSelect]
  );

  // Arrow keys move the active cover, Home/End jump to the ends, Enter/Space
  // opens the focused cover — global listener since the carousel has no
  // natural single focusable element to bind to, but skipped while the user
  // is typing into an input/textarea/contenteditable elsewhere on the page.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTyping) return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          goTo(activeIndex - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          goTo(activeIndex + 1);
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(entries.length - 1);
          break;
        case "Enter":
        case " ":
          if (onActiveCardClick) {
            e.preventDefault();
            onActiveCardClick();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, entries.length, goTo, onActiveCardClick]);

  if (entries.length === 0) {
    return (
      <Card>
        <p className="text-white/40 text-center py-12">
          No games in the Library yet. Start the engine and play a game to populate it.
        </p>
      </Card>
    );
  }

  const STEP = CARD_WIDTH + CARD_GAP;
  const windowStart = Math.max(0, activeIndex - CAROUSEL_WINDOW);
  const windowEnd = Math.min(entries.length - 1, activeIndex + CAROUSEL_WINDOW);
  const visibleEntries = entries.slice(windowStart, windowEnd + 1);

  return (
    <div className="relative w-full" style={{ height: 520 }}>
      <button
        onClick={() => goTo(activeIndex - 1)}
        className="absolute z-20 w-11 h-11 flex items-center justify-center bg-black/60 border border-white/10 rounded-full text-white/60 hover:text-white hover:bg-black/80 transition-all cursor-pointer backdrop-blur-sm"
        style={{ left: -8, top: "50%", transform: "translateY(-50%)" }}
      >
        ‹
      </button>

      <div className="absolute" style={{ top: 0, left: 80, right: 80, bottom: 0 }}>
        <div
          ref={trackRef}
          className="flex items-center h-full transition-transform duration-500 ease-out"
          style={{
            gap: `${CARD_GAP}px`,
            transform: `translateX(${-(activeIndex - windowStart) * STEP}px)`,
            willChange: "transform",
          }}
        >
          {visibleEntries.map((entry, visibilityIdx) => {
            const i = windowStart + visibilityIdx;
            return (
              <CarouselCard
                key={entry.title}
                entry={entry}
                index={i}
                isActive={i === activeIndex}
                offset={i - activeIndex}
                onSelect={() => {
                  if (i === activeIndex && onActiveCardClick) onActiveCardClick();
                  else if (i !== activeIndex) onSelect(i);
                }}
              />
            );
          })}
        </div>
      </div>

      <button
        onClick={() => goTo(activeIndex + 1)}
        className="absolute z-20 w-11 h-11 flex items-center justify-center bg-black/60 border border-white/10 rounded-full text-white/60 hover:text-white hover:bg-black/80 transition-all cursor-pointer backdrop-blur-sm"
        style={{ right: -8, top: 240, transform: "translateY(-50%)" }}
      >
        ›
      </button>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
        <span className="text-[10px] text-white/30 font-mono">
          {activeIndex + 1} / {entries.length}
        </span>
      </div>
    </div>
  );
}

function CarouselCard({
  entry,
  isActive,
  offset,
  onSelect,
}: {
  entry: ForgeLibraryEntry;
  index: number;
  isActive: boolean;
  offset: number;
  onSelect: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef({ x: 0, y: 0 });

  const baseTiltY = offset * 4;
  const baseTiltX = Math.abs(offset) * -1.5;

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isActive) return;
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      tiltRef.current = {
        x: (y - 0.5) * -20,
        y: (x - 0.5) * 20,
      };
      const el = cardRef.current?.firstElementChild as HTMLElement | null;
      if (el) {
        el.style.transform = `rotateX(${tiltRef.current.x + baseTiltX}deg) rotateY(${tiltRef.current.y + baseTiltY}deg) scale(1.07)`;
      }
    },
    [isActive, baseTiltX, baseTiltY]
  );

  const handleMouseLeave = useCallback(() => {
    tiltRef.current = { x: 0, y: 0 };
    const el = cardRef.current?.firstElementChild as HTMLElement | null;
    if (el) {
      el.style.transform = isActive ? "scale(1.07)" : "";
    }
  }, [isActive]);

  const dist = Math.abs(offset);
  const cardScale = isActive ? 1.07 : Math.max(0.65, 0.82 - dist * 0.04);
  const unfocusAmount = isActive ? 0 : Math.min(1, dist * 0.15);

  return (
    <div
      className="flex-shrink-0 cursor-pointer flex flex-col items-center"
      style={{
        width: CARD_WIDTH,
        zIndex: isActive ? 10 : 10 - dist,
      }}
      onClick={onSelect}
    >
      <div
        ref={cardRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          perspective: 1200,
          filter: isActive
            ? "none"
            : `brightness(${1 - unfocusAmount * 0.7}) blur(${unfocusAmount * 3}px)`,
          transition: "filter 0.3s ease",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 16,
            overflow: "hidden",
            transform: isActive
              ? `rotateX(${baseTiltX}deg) rotateY(${baseTiltY}deg) scale(${cardScale})`
              : `scale(${cardScale})`,
            transition: isActive ? "transform 0.15s ease-out" : "transform 0.3s ease-out",
            border: isActive ? "2px solid rgba(145,70,255,0.5)" : "1px solid rgba(255,255,255,0.1)",
            boxShadow: isActive
              ? "0 20px 60px rgba(0,0,0,0.7), 0 8px 24px rgba(0,0,0,0.5), 0 0 40px rgba(145,70,255,0.2), 0 0 60px rgba(145,70,255,0.08)"
              : "0 2px 8px rgba(0,0,0,0.15), 0 0 20px rgba(0,0,0,0.08)",
            background: "rgba(0,0,0,0.3)",
            transformStyle: "preserve-3d",
          }}
        >
          <div
            className="w-full h-full"
            style={{
              animation: isActive
                ? "var(--user-cover-breathe, cover-breathe 8s ease-in-out infinite)"
                : "none",
            }}
          >
            <CoverImage src={entry.cover_url} alt={entry.title} lazy />
          </div>

          {isActive && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                borderRadius: "inherit",
                mixBlendMode: "screen",
                animation: "var(--user-cover-glint, glint-slide 8s linear infinite)",
                background:
                  "linear-gradient(105deg, transparent 0%, transparent 40%, rgba(255,255,255,0.04) 46%, rgba(255,255,255,0.1) 49%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.1) 51%, rgba(255,255,255,0.04) 54%, transparent 60%, transparent 100%)",
                backgroundSize: "250% 100%",
              }}
            />
          )}
        </div>
      </div>

      {/* Title pill */}
      <div
        className={`mt-3 overflow-hidden transition-all duration-500 ease-out ${
          isActive ? "max-h-12 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="inline-flex mx-auto items-center px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.1] backdrop-blur-sm shadow-sm shadow-black/20">
          <span
            className={`text-xs font-medium truncate transition-all duration-300 ${
              isActive ? "text-white/90" : "text-white/30"
            }`}
            style={{ maxWidth: CARD_WIDTH - 40 }}
          >
            {entry.title}
          </span>
        </div>
      </div>
    </div>
  );
}
