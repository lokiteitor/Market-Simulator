/**
 * processLabels.ts — etiquetas en español y mapeo a Badge para los estados
 * de procesos de transformación [FE7]. Archivo hoja sin dependencias React.
 */
import type { ProcessStatus } from "../../api/types";
import type { BadgeKind } from "../../components";

export const PROCESS_STATUS_LABEL: Record<ProcessStatus, string> = {
  running: "En curso",
  completed: "Completado",
  cancelled: "Cancelado",
};

/** `running` usa el alias visual de `active` (verde) definido en Badge. */
export const PROCESS_STATUS_BADGE: Record<ProcessStatus, BadgeKind> = {
  running: "running",
  completed: "completed",
  cancelled: "cancelled",
};
