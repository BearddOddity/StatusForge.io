import { useState, useEffect, useCallback } from "react";
import type { AppConfig, ToastType } from "@/types";
import { tauriApi, saveConfig } from "@/hooks/useTauriApi";
import { Card, Btn, Field } from "@/components/primitives";

export default function RoutingView({
  toast,
}: {
  toast: (msg: string, type?: ToastType) => void;
}) {
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

  const set = (section: string, key: string, value: string | number) => {
    setConfig((prev) => ({
      ...prev!,
      [section]: { ...(prev as Record<string, Record<string, string | number>>)[section], [key]: value },
    }));
  };

  if (!config) {
    return (
      <div>
        <h2 className="text-2xl font-bold text-white mb-8">Routing</h2>
        <Card>
          <p>Loading...</p>
        </Card>
      </div>
    );
  }

  const bc = config.broadcaster || ({} as AppConfig["broadcaster"]);
  const es = config.engine_settings || ({} as AppConfig["engine_settings"]);

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-8">Routing</h2>

      <Card>
        <h3 className="text-white font-semibold mb-5">Mode</h3>
        <Field label="Routing Mode">
          <select
            value={bc.routing_mode || "streamer_bot"}
            onChange={(e) => set("broadcaster", "routing_mode", e.target.value)}
            className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500 cursor-pointer"
          >
            <option value="streamer_bot">Streamer.bot</option>
            <option value="native">Native (Direct API)</option>
          </select>
        </Field>
        {(bc.routing_mode || "streamer_bot") === "streamer_bot" && (
          <>
            <Field label="Streamer.bot Port">
              <input
                type="number"
                value={es.sb_port || 8080}
                onChange={(e) =>
                  set("engine_settings", "sb_port", parseInt(e.target.value) || 8080)
                }
                className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500"
              />
            </Field>
            <Field label="Action Name">
              <input
                value={es.sb_action_name || "UpdateCategory"}
                onChange={(e) => set("engine_settings", "sb_action_name", e.target.value)}
                className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500"
              />
            </Field>
          </>
        )}
      </Card>

      <Card>
        <h3 className="text-white font-semibold mb-5">Twitch</h3>
        {(
          [
            ["twitch_client", "Client ID"],
            ["twitch_secret", "Client Secret"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="password"
              value={bc[key] || ""}
              onChange={(e) => set("broadcaster", key, e.target.value)}
              placeholder={`Enter ${label}`}
              className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500 placeholder:text-white/30"
            />
          </Field>
        ))}
        <Btn
          className="mt-2.5"
          onClick={() =>
            window.open("http://127.0.0.1:53735/twitch/login", "_blank")
          }
        >
          🔗 Connect Twitch
        </Btn>
      </Card>

      <Card>
        <h3 className="text-white font-semibold mb-5">Kick</h3>
        {(
          [
            ["kick_client", "Client ID"],
            ["kick_secret", "Client Secret"],
            ["kick_channel_id", "Channel ID"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type={key.includes("secret") ? "password" : "text"}
              value={bc[key] || ""}
              onChange={(e) => set("broadcaster", key, e.target.value)}
              placeholder={`Enter ${label}`}
              className="w-full px-3.5 py-2.5 bg-black/40 border border-white/15 rounded-lg text-white text-sm outline-none focus:border-purple-500 placeholder:text-white/30"
            />
          </Field>
        ))}
        <Btn
          className="mt-2.5"
          onClick={() =>
            window.open("http://127.0.0.1:53735/kick/login", "_blank")
          }
        >
          🔗 Connect Kick
        </Btn>
      </Card>

      <div className="flex gap-3">
        <Btn onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save Routing"}
        </Btn>
        <Btn variant="ghost" onClick={loadConfig}>
          Reset
        </Btn>
      </div>
    </div>
  );
}
