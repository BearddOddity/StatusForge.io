import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

type Status = "connecting" | "success" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
  platform: "twitch" | "kick";
  connectUrl: string;
  onSuccess?: () => void;
}

const PLATFORM_META = {
  twitch: {
    label: "Twitch",
    color: "#9146FF",
    gradient: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)",
    icon: (
      <svg width="24" height="24" viewBox="0 0 2400 2800" fill="currentColor">
        <path d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600 V1300z" />
        <rect x="1700" y="550" width="200" height="600" />
        <rect x="1150" y="550" width="200" height="600" />
      </svg>
    ),
  },
  kick: {
    label: "Kick",
    color: "#00e676",
    gradient: "linear-gradient(135deg, #00e676 0%, #00b248 100%)",
    icon: (
      <svg width="24" height="24" viewBox="0 0 453.9 510.6" fill="currentColor">
        <path d="M0,0h170.2v113.5h56.7v-56.7h56.7V0h170.2v170.2h-56.7v56.7h-56.7v56.7h56.7v56.7h56.7v170.2h-170.2v-56.7h-56.7v-56.7h-56.7v113.5H0V0Z" />
      </svg>
    ),
  },
};

export default function OAuthConnectModal({
  open,
  onClose,
  platform,
  connectUrl,
  onSuccess,
}: Props) {
  const [status, setStatus] = useState<Status>("connecting");
  const [winRef, setWinRef] = useState<Window | null>(null);
  const [animateIn, setAnimateIn] = useState(false);
  const meta = PLATFORM_META[platform];
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleClose = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (winRef && !winRef.closed) winRef.close();
    setWinRef(null);
    setStatus("connecting");
    onClose();
  }, [winRef, onClose]);

  useEffect(() => {
    if (!open) {
      setAnimateIn(false);
      return;
    }
    requestAnimationFrame(() => setAnimateIn(true));
  }, [open]);

  useEffect(() => {
    if (!open) return;

    setStatus("connecting");
    const win = window.open(connectUrl, "oauth-connect", "width=520,height=700,scrollbars=yes,resizable=yes");
    setWinRef(win);

    const handler = (e: MessageEvent) => {
      if (e.data && e.data.type === "oauth-callback" && e.data.platform === platform) {
        if (pollRef.current) clearInterval(pollRef.current);
        if (e.data.status === "success") {
          setStatus("success");
          onSuccess?.();
        } else {
          setStatus("error");
        }
        if (win && !win.closed) win.close();
        setWinRef(null);
      }
    };
    window.addEventListener("message", handler);

    pollRef.current = setInterval(() => {
      if (win && win.closed) {
        if (pollRef.current) clearInterval(pollRef.current);
        setWinRef(null);
        // Only auto-close if still connecting (user closed popup without completing)
        setStatus((prev) => prev === "connecting" ? "connecting" : prev);
        // Don't auto-close — let user see the state or click cancel
      }
    }, 500);

    return () => {
      window.removeEventListener("message", handler);
      if (pollRef.current) clearInterval(pollRef.current);
      if (win && !win.closed) win.close();
    };
  }, [open, platform, connectUrl]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={handleClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />

      {/* Card */}
      <div
        className="relative w-[90vw] max-w-[400px] flex flex-col items-center text-center"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: animateIn ? 1 : 0,
          transform: animateIn ? "translateY(0) scale(1)" : "translateY(20px) scale(0.95)",
          transition: "opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Glass card */}
        <div
          className="w-full rounded-2xl overflow-hidden"
          style={{
            background: "rgba(0, 0, 0, calc(0.35 + var(--user-panel-opacity, 0.3) * 0.5))",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            boxShadow: `0 32px 80px rgba(0, 0, 0, 0.6), 0 0 120px ${meta.color}10, inset 0 1px 0 rgba(255, 255, 255, 0.05)`,
          }}
        >
          {/* Top accent line */}
          <div className="h-[2px] w-full" style={{ background: meta.gradient }} />

          <div className="px-7 pt-8 pb-7">
            {/* Platform icon with glow */}
            <div className="relative mx-auto mb-6 w-[72px] h-[72px]">
              {/* Pulse ring when connecting */}
              {status === "connecting" && (
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20"
                  style={{ backgroundColor: meta.color, animationDuration: "2s" }}
                />
              )}
              <div
                className="relative w-full h-full rounded-2xl flex items-center justify-center"
                style={{
                  background: `${meta.color}15`,
                  border: `1px solid ${meta.color}30`,
                  color: meta.color,
                  boxShadow: `0 0 30px ${meta.color}15`,
                }}
              >
                {status === "success" ? (
                  <svg className="w-8 h-8" fill="none" stroke="#4ade80" viewBox="0 0 24 24" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : status === "error" ? (
                  <svg className="w-8 h-8" fill="none" stroke="#f87171" viewBox="0 0 24 24" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <div className="relative">
                    {meta.icon}
                    {/* Spinner overlay */}
                    <svg
                      className="absolute -top-1 -right-1 w-4 h-4 animate-spin"
                      style={{ color: meta.color }}
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  </div>
                )}
              </div>
            </div>

            {/* Title */}
            <h3 className="text-white font-bold text-lg mb-1.5">
              {status === "connecting" && `Connect to ${meta.label}`}
              {status === "success" && `${meta.label} Connected`}
              {status === "error" && "Connection Failed"}
            </h3>

            {/* Subtitle */}
            <p className="text-white/40 text-[13px] leading-relaxed mb-6 max-w-[280px] mx-auto">
              {status === "connecting" &&
                `A ${meta.label} authorization window has been opened. Please log in and grant access to continue.`}
              {status === "success" &&
                "Your account has been linked. You can now use all streaming features."}
              {status === "error" &&
                "We couldn't complete the authorization. This can happen if the popup was closed early or access was denied."}
            </p>

            {/* Connecting progress dots */}
            {status === "connecting" && (
              <div className="flex items-center justify-center gap-1.5 mb-6">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: meta.color,
                      opacity: 0.3,
                      animation: `oauth-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Actions */}
            {status === "connecting" && (
              <button
                onClick={handleClose}
                className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
              >
                Cancel
              </button>
            )}

            {status === "success" && (
              <button
                onClick={handleClose}
                className="w-full py-2.5 rounded-xl text-xs font-semibold text-white transition-all cursor-pointer border-none"
                style={{ background: meta.gradient, boxShadow: `0 4px 20px ${meta.color}30` }}
              >
                Done
              </button>
            )}

            {status === "error" && (
              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setStatus("connecting");
                    if (pollRef.current) clearInterval(pollRef.current);
                    const win = window.open(connectUrl, "oauth-connect", "width=520,height=700,scrollbars=yes,resizable=yes");
                    setWinRef(win);
                  }}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-white transition-all cursor-pointer border-none"
                  style={{ background: meta.gradient, boxShadow: `0 4px 20px ${meta.color}30` }}
                >
                  Try Again
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-7 py-3 border-t border-white/[0.05] flex items-center justify-center gap-2">
            <div className="w-3 h-3 rounded-md bg-white/[0.06] flex items-center justify-center">
              <svg className="w-2 h-2 text-white/20" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="text-[10px] text-white/20 font-medium tracking-wide">STATUSFORGE.IO</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
