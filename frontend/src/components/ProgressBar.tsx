/**
 * ProgressBar — barra de progreso accesible (role="progressbar" +
 * aria-valuenow/min/max). Usada p.ej. para el avance de procesos de
 * transformación (value = transcurrido, max = duración).
 */
import styles from "./ProgressBar.module.css";

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Texto accesible/visible (ej. "Ejecución 2/5"). */
  label?: string;
}

export function ProgressBar({ value, max, label }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const pct = Math.round((clamped / safeMax) * 100);

  return (
    <div className={styles["wrap"]}>
      {label !== undefined && <span className={styles["label"]}>{label}</span>}
      <div
        className={styles["track"]}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={`${pct}%`}
        aria-label={label ?? "Progreso"}
      >
        <div className={styles["fill"]} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles["pct"]} aria-hidden="true">
        {pct}%
      </span>
    </div>
  );
}
