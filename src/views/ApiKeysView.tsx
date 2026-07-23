import { useState, useEffect, useCallback } from "react";
import type { AppConfig, ToastType } from "@statusforge/types";
import { tauriApi, saveConfig } from "@statusforge/hooks/useTauriApi";
import { Card, Btn, Field } from "@statusforge/components/primitives";

export default function ApiKeysView({ toast }: { toast: (msg: string, type?: ToastType) => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    const res = await tauriApi("export_config");
    if (res && typeof res === "object" && !("error" in res)) {
      setConfig(res as AppConfig);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    const res = await saveConfig(config);
    toast(res, res.includes("success") ? "success" : "error");
    setSaving(false);
  };

  const set = (section: string, key: string, value: string) => {
    setConfig((prev) => ({
      ...prev!,
      [section]: {
        ...(prev as unknown as Record<string, Record<string, string>>)[section],
        [key]: value,
      },
    }));
  };

  if (!config) {
    return (
      <div>
        <h2 className="text-2xl font-bold text-white mb-8">API Keys</h2>
        <Card>
          <p>Loading...</p>
        </Card>
      </div>
    );
  }

  const apiKeys = config.api_keys || ({} as AppConfig["api_keys"]);

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-8">API Keys</h2>
      <Card>
        <h3 className="text-white font-semibold mb-5">Metadata API Keys</h3>
        {(
          [
            ["steamgrid", "SteamGridDB API Key"],
            ["rawg", "RAWG API Key"],
            ["igdb_client", "IGDB Client ID"],
            ["igdb_secret", "IGDB Client Secret"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="password"
              value={apiKeys[key] || ""}
              onChange={(e) => set("api_keys", key, e.target.value)}
              placeholder={`Enter ${label}`}
              className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500 placeholder:text-white/30"
            />
          </Field>
        ))}
        <div className="flex gap-3 mt-5">
          <Btn onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save API Keys"}
          </Btn>
          <Btn variant="ghost" onClick={loadConfig}>
            Reset
          </Btn>
        </div>
      </Card>
    </div>
  );
}
