import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Toast as ToastItem, ToastType } from "@/types";

// ─── Toast hook ───────────────────────────────────────────────────────────────

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const add = useCallback((message: string, type: ToastType = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return { toasts, add };
}

// ─── Toast container ──────────────────────────────────────────────────────────

export function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-5 right-5 z-[9999] flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
