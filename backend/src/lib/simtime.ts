/**
 * Tiempo simulado (contrato §4).
 *
 * El reloj de pared es REAL; los TTLs y duraciones de dominio se expresan en
 * SEGUNDOS SIMULADOS. `config.simTimeFactor` = segundos simulados por segundo
 * real (factor 5 ⇒ 60 s simulados transcurren en 12 s reales).
 */
import { config } from "../config";

/** ms reales que tarda en transcurrir `simSeconds` segundos simulados. */
export function simSecondsToRealMs(simSeconds: number): number {
  return (simSeconds * 1000) / config.simTimeFactor;
}

/** Inversa: segundos simulados que representan `ms` milisegundos reales. */
export function realMsToSimSeconds(ms: number): number {
  return (ms * config.simTimeFactor) / 1000;
}

/** Instante real de expiración para un TTL en segundos simulados. */
export function expiresAtFromTtl(now: Date, ttlSimSeconds: number): Date {
  return new Date(now.getTime() + simSecondsToRealMs(ttlSimSeconds));
}

/**
 * `expected_end_at` de un proceso (§4):
 * started_at + simSecondsToRealMs(durationSimSeconds × executions).
 */
export function processExpectedEndAt(
  startedAt: Date,
  durationSimSeconds: number,
  executions: number,
): Date {
  return new Date(startedAt.getTime() + simSecondsToRealMs(durationSimSeconds * executions));
}

/**
 * Salario total de un proceso (§4): wage_rate × duración × ejecuciones.
 * Enteros con producto exacto (BigInt) — sin redondeos intermedios.
 */
export function wageCentsForProcess(
  wageRateCentsPerSec: number,
  durationSimSeconds: number,
  executions: number,
): number {
  if (
    !Number.isSafeInteger(wageRateCentsPerSec) ||
    !Number.isSafeInteger(durationSimSeconds) ||
    !Number.isSafeInteger(executions)
  ) {
    throw new Error(
      `wageCentsForProcess: argumentos deben ser enteros seguros; recibido: ` +
        `${wageRateCentsPerSec}, ${durationSimSeconds}, ${executions}`,
    );
  }
  return Number(BigInt(wageRateCentsPerSec) * BigInt(durationSimSeconds) * BigInt(executions));
}

// ---------------------------------------------------------------------------
// Parseo de INTERVAL de Postgres → segundos simulados
// ---------------------------------------------------------------------------

// Equivalencias de EXTRACT(EPOCH FROM interval) en Postgres:
// 1 año = 365.25 días; 1 mes = 30 días.
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY; // 2 592 000
const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY; // 31 557 600

const UNIT_SECONDS: Record<string, number> = {
  year: SECONDS_PER_YEAR,
  yr: SECONDS_PER_YEAR,
  y: SECONDS_PER_YEAR,
  mon: SECONDS_PER_MONTH,
  month: SECONDS_PER_MONTH,
  week: 7 * SECONDS_PER_DAY,
  w: 7 * SECONDS_PER_DAY,
  day: SECONDS_PER_DAY,
  d: SECONDS_PER_DAY,
  hour: SECONDS_PER_HOUR,
  hr: SECONDS_PER_HOUR,
  h: SECONDS_PER_HOUR,
  min: SECONDS_PER_MINUTE,
  minute: SECONDS_PER_MINUTE,
  m: SECONDS_PER_MINUTE,
  sec: 1,
  second: 1,
  s: 1,
  millisecond: 0.001,
  ms: 0.001,
  microsecond: 0.000001,
  us: 0.000001,
};

// "1 day", "-2 mons", "3 years", "@ 2 hours", "5 secs", …
const UNIT_TOKEN_RE =
  /([+-]?\d+(?:\.\d+)?)\s*(years?|yrs?|mons?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|secs?|seconds?|milliseconds?|ms|microseconds?|us|[ydhmsw])(?![a-z])/giy;
// Parte horaria "HH:MM:SS[.frac]" o "HH:MM" con signo opcional.
const TIME_TOKEN_RE = /([+-]?)(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/y;

/**
 * Convierte un INTERVAL de Postgres (tal como lo devuelve postgres.js: string)
 * a SEGUNDOS SIMULADOS (= EXTRACT(EPOCH FROM interval), ya que los intervals de
 * recetas están definidos en tiempo simulado).
 *
 * Formatos soportados (intervalstyle `postgres` y `postgres_verbose`):
 *   "01:00:00"                          → 3600
 *   "1 day 02:03:04"                    → 93784
 *   "2 days"                            → 172800
 *   "1 year 2 mons 3 days 04:05:06.5"   → años/meses con equivalencia de Postgres
 *   "-1 days +02:03:00"                 → signos por componente
 *   "@ 1 day 2 hours 3 mins 4 secs ago" → verbose (ago niega el total)
 */
export function intervalToSimSeconds(interval: string): number {
  if (typeof interval !== "string") {
    throw new Error(`intervalToSimSeconds: se esperaba string; recibido: ${typeof interval}`);
  }
  let text = interval.trim().toLowerCase();
  if (text.length === 0) {
    throw new Error("intervalToSimSeconds: interval vacío");
  }
  // Estilo verbose: prefijo "@" y sufijo "ago" (niega el total).
  let negateAll = false;
  if (text.startsWith("@")) text = text.slice(1).trim();
  if (text.endsWith(" ago")) {
    negateAll = true;
    text = text.slice(0, -4).trim();
  }

  let total = 0;
  let pos = 0;
  let matchedAny = false;

  while (pos < text.length) {
    // saltar espacios y comas separadoras
    const ch = text[pos];
    if (ch === " " || ch === ",") {
      pos += 1;
      continue;
    }

    UNIT_TOKEN_RE.lastIndex = pos;
    const unitMatch = UNIT_TOKEN_RE.exec(text);
    if (unitMatch) {
      const value = Number(unitMatch[1]);
      const unitWord = unitMatch[2] ?? "";
      // Quita el plural, salvo en unidades que SON "s"/"ms"/"us".
      const singular =
        unitWord === "s" || unitWord === "ms" || unitWord === "us"
          ? unitWord
          : unitWord.replace(/s$/, "");
      const factor = UNIT_SECONDS[singular];
      if (factor === undefined) {
        throw new Error(`intervalToSimSeconds: unidad desconocida "${unitWord}" en "${interval}"`);
      }
      total += value * factor;
      pos = UNIT_TOKEN_RE.lastIndex;
      matchedAny = true;
      continue;
    }

    TIME_TOKEN_RE.lastIndex = pos;
    const timeMatch = TIME_TOKEN_RE.exec(text);
    if (timeMatch) {
      const sign = timeMatch[1] === "-" ? -1 : 1;
      const hours = Number(timeMatch[2]);
      const minutes = Number(timeMatch[3]);
      const seconds = timeMatch[4] !== undefined ? Number(timeMatch[4]) : 0;
      total += sign * (hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds);
      pos = TIME_TOKEN_RE.lastIndex;
      matchedAny = true;
      continue;
    }

    throw new Error(`intervalToSimSeconds: no se pudo parsear "${interval}" (en "${text.slice(pos)}")`);
  }

  if (!matchedAny) {
    throw new Error(`intervalToSimSeconds: no se pudo parsear "${interval}"`);
  }
  return negateAll ? -total : total;
}
