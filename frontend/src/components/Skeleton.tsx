/**
 * Skeleton — placeholder de carga en forma de barras pulsantes.
 * Anuncia "Cargando" a lectores de pantalla; las barras son decorativas.
 */
import styles from "./Skeleton.module.css";

export interface SkeletonProps {
  /** Número de barras a renderizar. Default 3. */
  rows?: number;
}

export function Skeleton({ rows = 3 }: SkeletonProps) {
  return (
    <div className={styles.skeleton} role="status" aria-label="Cargando">
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <div key={i} className={styles.bar} aria-hidden="true" />
      ))}
    </div>
  );
}
