/**
 * StatCard — KPI del dashboard: etiqueta + valor grande (+ delta y hint).
 * El valor se pinta en monoespaciada (datos numéricos, regla del design doc).
 * Si `delta` es un string que empieza por "+" o "-", se colorea
 * success/danger; en otro caso queda neutro.
 */
import type { ReactNode } from "react";

import styles from "./StatCard.module.css";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  hint?: string;
}

function deltaClass(delta: ReactNode): string {
  const base = styles["delta"] ?? "";
  if (typeof delta === "string") {
    if (delta.startsWith("+")) return `${base} ${styles["deltaUp"] ?? ""}`;
    if (delta.startsWith("-")) return `${base} ${styles["deltaDown"] ?? ""}`;
  }
  return base;
}

export function StatCard({ label, value, delta, hint }: StatCardProps) {
  return (
    <div className={styles["card"]}>
      <p className={styles["label"]}>{label}</p>
      <p className={styles["value"]}>{value}</p>
      {(delta !== undefined || hint !== undefined) && (
        <p className={styles["foot"]}>
          {delta !== undefined && (
            <span className={deltaClass(delta)}>{delta}</span>
          )}
          {hint !== undefined && <span className={styles["hint"]}>{hint}</span>}
        </p>
      )}
    </div>
  );
}
