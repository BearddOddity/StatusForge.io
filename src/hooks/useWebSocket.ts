import { useEffect, useRef, useState, useCallback } from "react";
import type { EngineStatusData } from "@/types";
import { loadSystemPrefs } from "@/systemPrefs";

interface WSMessage {
  event: "init" | "update" | "error";
  payload?: EngineStatusData;
  message?: string;
}

export function useWebSocket(token: string) {
  const [connected, setConnected] = useState(false);
  const [data, setData] = useState<EngineStatusData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(
    (wsToken: string) => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);

      const ws = new WebSocket(
        `ws://127.0.0.1:53735/ws?token=${encodeURIComponent(wsToken)}`
      );
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          if ((msg.event === "update" || msg.event === "init") && msg.payload) {
            setData(msg.payload);
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        // System pref: "Auto-Reconnect WebSocket" — read at drop time so a
        // toggle takes effect without remounting the hook.
        if (loadSystemPrefs().wsAutoReconnect) {
          reconnectRef.current = setTimeout(() => connect(wsToken), 3000);
        }
      };

      ws.onerror = () => ws.close();
    },
    []
  );

  useEffect(() => {
    if (token && token !== "Unknown" && token !== "Loading...") {
      connect(token);
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [token, connect]);

  return { connected, data };
}
