/**
 * Paleta categórica de las gráficas del panel admin. Colores elegidos para
 * contrastar sobre fondos claros y oscuros (mismo hue, luminosidad media).
 */
export const CHART_COLORS = [
  "#2f9e5f", // verde (marca)
  "#3b82f6", // azul
  "#f59e0b", // ámbar
  "#8b5cf6", // violeta
  "#ef4444", // rojo
  "#14b8a6", // teal
  "#ec4899", // rosa
  "#64748b", // gris azulado
] as const;

/** Color estable por índice (envuelve por módulo si hay más series que colores). */
export function colorAt(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] as string;
}

/** Neutro para la rejilla (semitransparente → sirve en claro y oscuro). */
export const GRID_STROKE = "rgba(127, 127, 127, 0.18)";
