/**
 * EmptyState — mensaje centrado para listas/tablas sin datos.
 */
import { IconInbox } from "./icons";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  title: string;
  hint?: string;
}

export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon}>
        <IconInbox size={28} />
      </span>
      <p className={styles.title}>{title}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
