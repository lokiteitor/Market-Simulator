/**
 * Toast — host global de notificaciones.
 *
 * Escucha el evento window `ma:toast` (CustomEvent con detail
 * {kind, title, body}) que dispara el proveedor de notificaciones WS
 * (o cualquier página vía `showToast`). Los toasts se apilan, se
 * auto-descartan a los 6 s y pueden cerrarse manualmente. La región usa
 * aria-live="polite" para lectores de pantalla.
 */
import { useEffect, useRef, useState } from "react";

import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";
import styles from "./Toast.module.css";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastDetail {
  kind?: ToastKind;
  title: string;
  body?: string;
}

/** Dispara un toast desde cualquier módulo (mismo canal que el WS). */
export function showToast(detail: ToastDetail): void {
  window.dispatchEvent(new CustomEvent("ma:toast", { detail }));
}

interface ToastItem extends Required<Pick<ToastDetail, "title">> {
  id: number;
  kind: ToastKind;
  body?: string;
}

const AUTO_DISMISS_MS = 6000;

function normalizeKind(kind: unknown): ToastKind {
  return kind === "success" || kind === "error" || kind === "warning"
    ? kind
    : "info";
}

const KIND_ICON = {
  success: IconCheck,
  error: IconAlert,
  warning: IconAlert,
  info: IconInfo,
} as const;

export function Toast() {
  const [items, setItems] = useState<ReadonlyArray<ToastItem>>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const dismiss = (id: number) => {
      const t = timers.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.current.delete(id);
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
    };

    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<Partial<ToastDetail>>).detail;
      if (!detail || typeof detail.title !== "string") return;

      const id = nextId.current++;
      const item: ToastItem = {
        id,
        kind: normalizeKind(detail.kind),
        title: detail.title,
        ...(typeof detail.body === "string" ? { body: detail.body } : {}),
      };
      setItems((prev) => [...prev, item]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    };

    window.addEventListener("ma:toast", onToast);
    const pending = timers.current;
    return () => {
      window.removeEventListener("ma:toast", onToast);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const close = (id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className={styles["host"]} aria-live="polite" aria-label="Notificaciones">
      {items.map((item) => {
        const Icon = KIND_ICON[item.kind];
        return (
          <div
            key={item.id}
            className={`${styles["toast"] ?? ""} ${styles[item.kind] ?? ""}`}
            role="status"
          >
            <span className={styles["icon"]}>
              <Icon size={18} />
            </span>
            <div className={styles["text"]}>
              <p className={styles["title"]}>{item.title}</p>
              {item.body && <p className={styles["body"]}>{item.body}</p>}
            </div>
            <button
              type="button"
              className={styles["close"]}
              onClick={() => close(item.id)}
              aria-label="Cerrar notificación"
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
