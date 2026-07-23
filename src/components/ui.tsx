import { useState, useEffect, type ReactNode } from "react";
import { resolveImageSrc } from "@statusforge/utils/imageSrc";

// ═══════════════════════════════════════════════════════════════════════════════
// Card — surface container (glass treatment)
// ═══════════════════════════════════════════════════════════════════════════════

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card-glass p-5 ${className}`}>{children}</div>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Btn — action button with variants (elevated glass treatment)
// ═══════════════════════════════════════════════════════════════════════════════

export function Btn({
  children,
  variant = "primary",
  disabled,
  onClick,
  className = "",
}: {
  children: ReactNode;
  variant?: "primary" | "danger" | "ghost" | "success";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const base =
    "px-4 py-2 rounded-xl text-[11px] font-semibold whitespace-nowrap transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border";
  const variants: Record<string, string> = {
    primary:
      "bg-white/[0.06] border-white/10 text-white/75 hover:bg-white/[0.1] hover:border-white/15 hover:text-white hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/20",
    danger:
      "bg-red-500/10 border-red-500/20 text-red-400/80 hover:bg-red-500/15 hover:border-red-500/30 hover:text-red-400 hover:-translate-y-0.5 hover:shadow-md hover:shadow-red-500/10",
    success:
      "bg-emerald-500/10 border-emerald-500/20 text-emerald-400/80 hover:bg-emerald-500/15 hover:border-emerald-500/30 hover:text-emerald-400 hover:-translate-y-0.5 hover:shadow-md hover:shadow-emerald-500/10",
    ghost:
      "bg-transparent border-white/[0.06] text-white/45 hover:bg-white/[0.04] hover:border-white/10 hover:text-white/70",
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// UiCard — elevated card with hover glow (for dashboard stat blocks)
// ═══════════════════════════════════════════════════════════════════════════════

export function UiCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card-glass p-5 ${className}`}>{children}</div>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UiBtn — pill-shaped CTA button (purple gradient)
// ═══════════════════════════════════════════════════════════════════════════════

export function UiBtn({
  children,
  disabled,
  onClick,
  className = "",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      className={`px-5 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg hover:-translate-y-0.5 active:translate-y-0 cursor-pointer border-none ${className}`}
      style={{
        background:
          "linear-gradient(to right, var(--user-accent, #9146FF), color-mix(in srgb, var(--user-accent, #9146FF) 100%, black 30%))",
        boxShadow: "0 10px 25px -5px color-mix(in srgb, var(--user-accent, #9146FF) 15%, transparent)",
      }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CoverImage — game cover with fallback
// ═══════════════════════════════════════════════════════════════════════════════

export function CoverImage({
  src,
  alt,
  className = "",
  lazy = false,
}: {
  src: string;
  alt: string;
  className?: string;
  lazy?: boolean;
}) {
  if (!src) {
    return (
      <div
        className={`w-full h-full bg-gradient-to-br from-[#1a1a2e] to-[#16213e] flex items-center justify-center p-4 ${className}`}
      >
        <span className="text-white/50 text-xs text-center font-semibold leading-tight">{alt}</span>
      </div>
    );
  }
  return (
    <img
      src={resolveImageSrc(src)}
      alt={alt}
      loading={lazy ? "lazy" : "eager"}
      className={`w-full h-full object-cover ${className}`}
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = "none";
        (e.target as HTMLImageElement).parentElement!.style.background =
          "linear-gradient(135deg, #1a1a2e, #16213e)";
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FieldSection — collapsible metadata section (new glass style)
// ═══════════════════════════════════════════════════════════════════════════════

export function FieldSection({
  title,
  children,
  defaultOpen = false,
  icon,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={`border rounded-2xl transition-all duration-300 overflow-hidden mb-4 ${
        open
          ? "bg-black/45 border-white/15 shadow-xl shadow-black/30"
          : "bg-black/20 border-white/5 hover:border-white/10 hover:bg-black/25"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left cursor-pointer select-none focus:outline-none bg-transparent border-none"
      >
        <div className="flex items-center gap-3 min-w-0">
          {icon && (
            <span className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/5 flex items-center justify-center text-sm shrink-0">
              {icon}
            </span>
          )}
          <span className="text-xs font-semibold text-white/85 tracking-wide uppercase">
            {title}
          </span>
        </div>
        <div
          className={`w-6 h-6 rounded-lg bg-white/[0.03] flex items-center justify-center text-white/40 transition-all duration-300 ${
            open ? "rotate-180 bg-white/[0.06]" : ""
          }`}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          open
            ? "grid-rows-[1fr] opacity-100 border-t border-white/[0.04]"
            : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="p-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MetadataField — inline-editable metadata field (glass treatment)
// ═══════════════════════════════════════════════════════════════════════════════

export function MetadataField({
  label,
  value,
  saving,
  onChange,
  onSave,
  onSearch,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  saving: boolean;
  onChange: (val: string) => void;
  onSave: (val: string) => void;
  onSearch?: () => void;
  placeholder?: string;
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value);

  useEffect(() => {
    setLocalVal(value);
  }, [value]);

  if (editing) {
    return (
      <div className="mb-4">
        <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
          {label}
        </label>
        <div className="flex gap-2">
          <input
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            placeholder={placeholder}
            className="input-glass flex-1 min-w-0"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onChange(localVal);
                onSave(localVal);
                setEditing(false);
              }
              if (e.key === "Escape") {
                setLocalVal(value);
                setEditing(false);
              }
            }}
          />
          <Btn
            variant="success"
            disabled={saving}
            onClick={() => {
              onChange(localVal);
              onSave(localVal);
              setEditing(false);
            }}
          >
            ✓
          </Btn>
          <Btn
            variant="ghost"
            onClick={() => {
              setLocalVal(value);
              setEditing(false);
            }}
          >
            ✕
          </Btn>
        </div>
        {hint && <p className="text-[10px] text-white/30 mt-1.5 leading-snug">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="mb-4 group">
      <label className="block text-[10px] uppercase tracking-wider text-white/40 mb-1.5 font-semibold">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <span
          className="flex-1 text-white/80 text-sm truncate cursor-pointer hover:text-white transition-colors min-w-0 py-1"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {value || <span className="text-white/20 italic">Not set</span>}
        </span>
        {onSearch && (
          <button
            onClick={onSearch}
            className="text-white/25 hover:text-purple-400 transition-all text-xs cursor-pointer bg-transparent border-none shrink-0 p-1 rounded-md hover:bg-white/[0.04]"
            title="Search APIs"
          >
            🔍
          </button>
        )}
        <button
          onClick={() => onSave(value)}
          className="text-white/25 hover:text-green-400 transition-all text-xs cursor-pointer bg-transparent border-none shrink-0 p-1 rounded-md hover:bg-white/[0.04]"
          title="Save"
        >
          💾
        </button>
        <button
          onClick={() => setEditing(true)}
          className="text-white/25 hover:text-white/60 transition-all text-xs cursor-pointer bg-transparent border-none shrink-0 p-1 rounded-md hover:bg-white/[0.04]"
          title="Edit"
        >
          ✎
        </button>
      </div>
      {hint && <p className="text-[10px] text-white/30 mt-1.5 leading-snug">{hint}</p>}
    </div>
  );
}
