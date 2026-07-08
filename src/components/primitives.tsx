import type React from "react";

// ─── Card ─────────────────────────────────────────────────────────────────────

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-black/20 border border-white/10 rounded-2xl p-5 mb-5 ${className}`}>
      {children}
    </div>
  );
}

// ─── Btn ──────────────────────────────────────────────────────────────────────

export function Btn({
  children,
  variant = "primary",
  disabled,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  variant?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const base =
    "px-3 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";
  const variants = {
    primary:
      "bg-white/[0.07] border border-white/10 text-white/80 shadow-lg shadow-black/30 hover:bg-white/[0.12] hover:shadow-black/40 hover:-translate-y-0.5",
    danger:
      "bg-white/[0.07] border border-white/10 text-white/80 shadow-lg shadow-black/30 hover:bg-white/[0.12] hover:shadow-black/40 hover:-translate-y-0.5",
    ghost:
      "bg-transparent border border-white/15 text-white/60 shadow-lg shadow-black/20 hover:bg-white/[0.06] hover:border-white/25 hover:shadow-black/30",
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

// ─── Field ────────────────────────────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

export function Tag({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "twitch" | "kick" | "sb";
}) {
  const variants: Record<string, string> = {
    default: "bg-white/10 text-white/60",
    twitch: "bg-purple-500/20 text-purple-400",
    kick: "bg-emerald-500/20 text-emerald-400",
    sb: "bg-amber-500/20 text-amber-400",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider ${variants[variant]}`}
    >
      {children}
    </span>
  );
}
