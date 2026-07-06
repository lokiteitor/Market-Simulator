/**
 * simTime.ts — Tiempo simulado ↔ tiempo real (factor de simulación 5×).
 *
 * Convención de la API (specs/openapi.yaml):
 * - `ttl_seconds` de las órdenes se envía en segundos SIMULADOS
 *   (60 = 1 min simulado … 604800 = 1 semana simulada); el servidor aplica
 *   el factor al calcular `expires_at`.
 * - `duration_seconds` de las recetas viene en segundos REALES: la UI la
 *   muestra tal cual y solo referencia la equivalencia simulada como hint
 *   (design doc §5 "Tiempo").
 */

/** Factor de simulación de la corrida (default del diseño: 5×). */
export const SIM_FACTOR = 5;

/** Segundos simulados → segundos reales (la simulación corre 5× más rápido). */
export function simToRealSeconds(simSeconds: number): number {
  return Math.round(simSeconds / SIM_FACTOR);
}

/** Segundos reales → segundos simulados. */
export function realToSimSeconds(realSeconds: number): number {
  return Math.round(realSeconds * SIM_FACTOR);
}

const DURATION_UNITS = [
  { label: "d", size: 86_400 },
  { label: "h", size: 3_600 },
  { label: "min", size: 60 },
  { label: "s", size: 1 },
] as const;

/**
 * Duración en segundos → texto legible con las dos unidades más
 * significativas: "12 s", "24 min", "1 h 30 min", "1 d 9 h".
 */
export function fmtDurationSeconds(seconds: number): string {
  let rest = Math.max(0, Math.round(seconds));
  if (rest === 0) return "0 s";
  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    if (parts.length === 2) break;
    const n = Math.trunc(rest / unit.size);
    if (n > 0) {
      parts.push(`${n} ${unit.label}`);
      rest -= n * unit.size;
    }
  }
  return parts.join(" ");
}

/** Preset de TTL del formulario de órdenes (en segundos simulados). */
export interface TtlPreset {
  simSeconds: number;
  label: string;
}

/** Presets del design doc: 1 min / 1 h / 6 h / 1 día / 1 semana SIMULADOS. */
export const TTL_PRESETS: readonly TtlPreset[] = [
  { simSeconds: 60, label: "1 min" },
  { simSeconds: 3_600, label: "1 h" },
  { simSeconds: 21_600, label: "6 h" },
  { simSeconds: 86_400, label: "1 día" },
  { simSeconds: 604_800, label: "1 semana" },
];

/** TTL preseleccionado del formulario (1 h simulada). */
export const DEFAULT_TTL_SIM_SECONDS = 3_600;

/**
 * Hint de equivalencia real de un TTL simulado:
 * "1 h simulados ≈ 12 min reales (factor 5×)".
 */
export function ttlEquivalenceHint(simSeconds: number): string {
  const sim = fmtDurationSeconds(simSeconds);
  const real = fmtDurationSeconds(simToRealSeconds(simSeconds));
  return `${sim} simulados ≈ ${real} reales (factor ${SIM_FACTOR}×)`;
}

/**
 * Hint de equivalencia simulada para duraciones REALES devueltas por la API
 * (recetas): "≈ 2 h simuladas (factor 5×)".
 */
export function realDurationSimHint(realSeconds: number): string {
  const sim = fmtDurationSeconds(realToSimSeconds(realSeconds));
  return `≈ ${sim} simuladas (factor ${SIM_FACTOR}×)`;
}
