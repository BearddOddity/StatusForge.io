import { useState, useEffect } from "react";
import type { EngineStatus, ToastType, KeychainStatus } from "@/types";
import { tauriApi, fetchWidgetToken, getKeychainStatus } from "@/hooks/useTauriApi";
import { Card, Btn, Field } from "@/components/primitives";

export default function EngineConfigView({
  engineStatus,
  onRefresh,
  toast,
}: {
  engineStatus: EngineStatus;
  onRefresh: () => void;
  toast: (msg: string, type?: ToastType) => void;
}) {
  const [widgetToken, setWidgetToken] = useState("Loading...");
  const [starting, setStarting] = useState(false);
  const [keychainInfo, setKeychainInfo] = useState<KeychainStatus | null>(null);

  useEffect(() => {
    fetchWidgetToken().then((t) => setWidgetToken(t));
    getKeychainStatus().then((s) => setKeychainInfo(s));
  }, []);

  const startEngine = async () => {
    setStarting(true);
    const res = await tauriApi("start_engine");
    toast(
      typeof res === "string" ? res : "Failed to start engine",
      typeof res === "string" ? "success" : "error"
    );
    setStarting(false);
    onRefresh();
  };

  const stopEngine = async () => {
    const res = await tauriApi("stop_engine");
    toast(
      typeof res === "string" ? res : "Failed to stop engine",
      typeof res === "string" ? "success" : "error"
    );
    onRefresh();
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-8">Engine Configuration</h2>

      <Card>
        <h3 className="text-white font-semibold mb-4">Control Panel</h3>
        <p className="text-white/60 mb-5">
          The native Rust detection engine broadcasts status on port 53735.
        </p>
        <div className="flex gap-3 mb-5">
          <Btn onClick={startEngine} disabled={starting || engineStatus.running}>
            {starting ? "Starting..." : "▶ Start Engine"}
          </Btn>
          <Btn variant="danger" onClick={stopEngine} disabled={!engineStatus.running}>
            ⏹ Stop Engine
          </Btn>
        </div>
        <p className="text-white/60 text-xs">
          Widget Token:{" "}
          <code className="bg-black/30 px-1.5 py-0.5 rounded">
            {widgetToken}
          </code>
        </p>
      </Card>

      <Card>
        <h3 className="text-white font-semibold mb-4">Token Security</h3>
        <p className="text-white/60 mb-4 text-sm">
          Migrate OAuth tokens from Config.json to the OS keychain (Windows
          Credential Manager / macOS Keychain / Linux Secret Service). This
          removes plaintext tokens from the config file.
        </p>
        <Btn
          onClick={async () => {
            const res = await tauriApi("migrate_tokens_to_keychain");
            if (Array.isArray(res) && res.length) {
              toast(`Migrated ${res.length} tokens to OS keychain`, "success");
            } else if (Array.isArray(res)) {
              toast("No tokens to migrate", "info");
            } else {
              toast("Migration failed", "error");
            }
          }}
        >
          🔒 Migrate Tokens to Keychain
        </Btn>
      </Card>

      {keychainInfo && (
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-[#FFD700]">
              Keychain: {keychainInfo.count} token{keychainInfo.count !== 1 ? "s" : ""} stored
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${keychainInfo.count > 0 ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
              {keychainInfo.count > 0 ? "Active" : "Empty"}
            </span>
          </div>
          {keychainInfo.stored.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {keychainInfo.stored.map((k) => (
                <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-[#2A2A32] text-gray-400 font-mono">
                  {k}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
