import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { tauriApi } from "@statusforge/hooks/useTauriApi";
import type { AppConfig } from "@statusforge/types";

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
  const [animateIn, setAnimateIn] = useState(false);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const meta = PLATFORM_META[platform];
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const slowHintRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by stopPolling() and read by in-flight attempts to notice they've
  // been superseded. Needed because launchAndPoll is async but called
  // without awaiting it from an effect — React StrictMode's dev-mode
  // mount/cleanup/remount double-invoke then races ahead of the async setup,
  // so a plain "clear whatever pollRef currently holds" cleanup can run
  // before pollRef is even set, leaving the first interval's ID never
  // captured and thus never cancellable once a second attempt overwrites
  // the ref — it just runs forever, firing onSuccess every tick.
  const generationRef = useRef(0);

  const stopPolling = useCallback(() => {
    generationRef.current++;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (slowHintRef.current) {
      clearTimeout(slowHintRef.current);
      slowHintRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    stopPolling();
    setStatus("connecting");
    setShowSlowHint(false);
    onClose();
  }, [stopPolling, onClose]);

  useEffect(() => {
    if (!open) {
      setAnimateIn(false);
      return;
    }
    requestAnimationFrame(() => setAnimateIn(true));
  }, [open]);

  // Tauri's webview can't open real detached popup windows (window.open()
  // silently fails/does nothing inside a webview) — the OAuth URL has to
  // launch in the user's actual system browser via the shell plugin
  // instead. That also means there's no `window.opener` for the callback
  // page to postMessage back to, so completion is detected by polling
  // export_config for the platform's token field going from empty to set
  // (the local /oauth/callback/:platform route already writes it to
  // Config.json as soon as the browser completes the redirect).
  const launchAndPoll = useCallback(async () => {
    stopPolling(); // invalidate + synchronously clear any prior attempt
    const myGeneration = generationRef.current;
    setStatus("connecting");
    setShowSlowHint(false);

    // No postMessage channel means we can't distinguish "still working" from
    // "actually failed" — surface a hint + manual retry after a while rather
    // than spinning forever with no feedback.
    slowHintRef.current = setTimeout(() => {
      if (generationRef.current === myGeneration) setShowSlowHint(true);
    }, 45_000);

    const tokenKey = `${platform}_token` as const;
    let hadTokenBefore = false;
    try {
      const before = await tauriApi("export_config");
      if (before && typeof before === "object" && "broadcaster" in before) {
        hadTokenBefore = !!(before as AppConfig).broadcaster[tokenKey];
      }
    } catch {
      // export_config failing shouldn't block trying to connect
    }

    // Superseded (a newer attempt started, or the modal closed) while we
    // were awaiting above — bail out before opening a second browser tab.
    if (generationRef.current !== myGeneration) return;

    try {
      await openUrl(connectUrl);
    } catch (e) {
      if (generationRef.current === myGeneration) setStatus("error");
      console.error("Failed to open browser for OAuth:", e);
      return;
    }

    if (generationRef.current !== myGeneration) return;

    const intervalId = setInterval(async () => {
      // A stale interval whose ID was orphaned by a superseded ref-write
      // notices it here and cancels itself instead of running forever.
      if (generationRef.current !== myGeneration) {
        clearInterval(intervalId);
        return;
      }
      try {
        const res = await tauriApi("export_config");
        if (generationRef.current !== myGeneration) {
          clearInterval(intervalId);
          return;
        }
        if (res && typeof res === "object" && "broadcaster" in res) {
          const hasTokenNow = !!(res as AppConfig).broadcaster[tokenKey];
          if (hasTokenNow && !hadTokenBefore) {
            clearInterval(intervalId);
            if (pollRef.current === intervalId) pollRef.current = null;
            setStatus("success");
            onSuccess?.();
          }
        }
      } catch {
        // transient failure — keep polling
      }
    }, 1500);
    pollRef.current = intervalId;
  }, [platform, connectUrl, onSuccess, stopPolling]);

  useEffect(() => {
    if (!open) return;
    launchAndPoll();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform, connectUrl]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[350] flex items-center justify-center" onClick={handleClose}>
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
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    stroke="#4ade80"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : status === "error" ? (
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    stroke="#f87171"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                  >
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
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="3"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
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
                `Your browser has opened to log in to ${meta.label}. This window will update automatically once you grant access.`}
              {status === "success" &&
                "Your account has been linked. You can now use all streaming features."}
              {status === "error" && "We couldn't open your browser to start the authorization."}
            </p>

            {status === "connecting" && showSlowHint && (
              <p className="text-white/25 text-[11px] leading-relaxed mb-4 max-w-[280px] mx-auto">
                Still waiting — if no browser tab opened, or you closed it without finishing, try
                again below.
              </p>
            )}

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
            {status === "connecting" && !showSlowHint && (
              <button
                onClick={handleClose}
                className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
              >
                Cancel
              </button>
            )}

            {status === "connecting" && showSlowHint && (
              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                >
                  Cancel
                </button>
                <button
                  onClick={() => launchAndPoll()}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-white transition-all cursor-pointer border-none"
                  style={{ background: meta.gradient, boxShadow: `0 4px 20px ${meta.color}30` }}
                >
                  Try Again
                </button>
              </div>
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
                  onClick={() => launchAndPoll()}
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
            <span className="text-[10px] text-white/20 font-medium tracking-wide">
              STATUSFORGE.IO
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
