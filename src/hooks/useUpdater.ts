import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Checks for a StatusForge update once per app launch. A failed/offline
// check is silent — it's a background convenience, not something that
// should ever interrupt someone trying to use the app.
export function useUpdater(
  toast: (msg: string, type?: "success" | "error" | "info") => void,
  autoCheckEnabled: boolean = true
) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!autoCheckEnabled) return;
    let cancelled = false;
    check()
      .then((result) => {
        if (!cancelled && result) setUpdate(result);
      })
      .catch(() => {
        // No update endpoint reachable, or nothing published yet — not an error state.
      });
    return () => {
      cancelled = true;
    };
  }, [autoCheckEnabled]);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setInstalling(false);
      toast("Update download failed — try again from Settings later.", "error");
    }
  }, [update, toast]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return {
    available: !!update && !dismissed,
    version: update?.version ?? "",
    installing,
    install,
    dismiss,
  };
}
