import { Btn } from "@statusforge/components/ui";

export default function UpdateBanner({
  version,
  installing,
  onInstall,
  onDismiss,
}: {
  version: string;
  installing: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="card-glass flex items-center justify-between gap-4 px-5 py-3 mb-5 border-purple-500/20 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-lg shrink-0">✨</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/85 truncate">
            StatusForge {version} is available
          </div>
          <div className="text-[11px] text-white/40">
            {installing
              ? "Downloading and installing — the app will restart automatically."
              : "Restart to install the update."}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!installing && (
          <button
            onClick={onDismiss}
            className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer bg-transparent border-none px-2 py-1"
          >
            Later
          </button>
        )}
        <Btn variant="success" onClick={onInstall} disabled={installing}>
          {installing ? "Installing…" : "Restart to Install"}
        </Btn>
      </div>
    </div>
  );
}
