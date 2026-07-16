import { useState } from "react";
import { createPortal } from "react-dom";
import type { ViewId } from "@/types";

interface Props {
  onFinish: () => void;
  onNavigate: (view: ViewId) => void;
}

interface Step {
  icon: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: "👋",
    title: "Welcome to StatusForge",
    body: "StatusForge watches what you're playing and updates your Twitch or Kick category automatically — no more forgetting to switch it yourself.",
  },
  {
    icon: "🔗",
    title: "Connect Twitch or Kick",
    body: "This is the one step that really matters — without it, StatusForge has nothing to update. You'll find it under Settings → API & Routing.",
  },
  {
    icon: "🎮",
    title: "Detection just works",
    body: "StatusForge checks what's running in the background — including most emulators — and figures out the game on its own. If it ever guesses wrong, fix it instantly from the Dashboard.",
  },
  {
    icon: "✅",
    title: "You're all set",
    body: "Everything else — API keys, themes, notifications — lives in Settings whenever you want it. Just start playing.",
  },
];

export default function OnboardingWizard({ onFinish, onNavigate }: Props) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const isConnectStep = step === 1;
  const current = STEPS[step];

  const goToSettings = () => {
    onNavigate("settings");
    onFinish();
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />

      <div className="relative w-[90vw] max-w-[440px] flex flex-col items-center text-center">
        <div
          className="w-full rounded-2xl overflow-hidden"
          style={{
            background: "rgba(0, 0, 0, calc(0.35 + var(--user-panel-opacity, 0.3) * 0.5))",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            boxShadow: "0 32px 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
          }}
        >
          <div
            className="h-[2px] w-full"
            style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
          />

          <div className="px-7 pt-8 pb-7">
            {/* Progress dots */}
            <div className="flex items-center justify-center gap-1.5 mb-6">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === step ? "20px" : "6px",
                    backgroundColor: i <= step ? "#9146FF" : "rgba(255,255,255,0.15)",
                  }}
                />
              ))}
            </div>

            <div className="text-4xl mb-4">{current.icon}</div>
            <h3 className="text-white font-bold text-lg mb-2">{current.title}</h3>
            <p className="text-white/50 text-[13px] leading-relaxed mb-7 max-w-[320px] mx-auto">
              {current.body}
            </p>

            {isConnectStep ? (
              <div className="flex flex-col gap-2">
                <button
                  onClick={goToSettings}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                  style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
                >
                  Go to Settings
                </button>
                <button
                  onClick={() => setStep(step + 1)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border border-white/[0.08] bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70"
                >
                  I'll do this later
                </button>
              </div>
            ) : (
              <button
                onClick={() => (isLast ? onFinish() : setStep(step + 1))}
                className="w-full py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-white"
                style={{ background: "linear-gradient(135deg, #9146FF 0%, #6441A5 100%)" }}
              >
                {isLast ? "Get Started" : "Continue"}
              </button>
            )}

            {!isLast && (
              <button
                onClick={onFinish}
                className="mt-4 text-[11px] text-white/25 hover:text-white/45 transition-colors cursor-pointer"
              >
                Skip setup guide
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
