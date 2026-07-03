/**
 * CopyId — UUID truncado a 8 caracteres (regla del design doc) + botón de
 * copiar el ID completo, con feedback visual y anuncio accesible.
 */
import { useEffect, useRef, useState } from "react";

import { truncId } from "../lib/format";
import { IconCheck, IconCopy } from "./icons";
import styles from "./CopyId.module.css";

export interface CopyIdProps {
  id: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* cae al fallback */
  }
  // Fallback para contextos sin Clipboard API (http, navegadores antiguos).
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyId({ id }: CopyIdProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    const ok = await copyText(id);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <span className={styles["wrap"]}>
      <code className={styles["id"]} title={id}>
        {truncId(id)}
      </code>
      <button
        type="button"
        className={styles["btn"]}
        onClick={() => void onCopy()}
        aria-label={copied ? "ID copiado" : `Copiar ID completo ${truncId(id)}`}
        title="Copiar ID completo"
      >
        {copied ? (
          <span className={styles["ok"]}>
            <IconCheck size={14} />
          </span>
        ) : (
          <IconCopy size={14} />
        )}
      </button>
      <span aria-live="polite" className={styles["sr"]}>
        {copied ? "ID copiado al portapapeles" : ""}
      </span>
    </span>
  );
}
