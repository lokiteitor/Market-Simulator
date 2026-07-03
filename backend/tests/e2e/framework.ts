/**
 * Mini-framework E2E [M11] — pasos secuenciales, aserciones y polling.
 *
 * POLÍTICA DE FALLO (decisión documentada, contrato §18): la suite ABORTA AL
 * PRIMER FALLO. Los pasos son estrictamente secuenciales y dependen del estado
 * creado por los anteriores (agentes, órdenes, procesos); continuar tras un
 * fallo solo produciría cascadas de errores sin valor diagnóstico. Al fallar:
 * se ejecutan los cleanups registrados (best-effort), se imprime el resumen de
 * pasos y el proceso sale con exit code 1. Si todo pasa: resumen y exit 0.
 *
 * Este archivo no depende de nada del servidor: es infraestructura de test.
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

interface StepRecord {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const records: StepRecord[] = [];

interface Cleanup {
  label: string;
  fn: () => Promise<void> | void;
}

const cleanups: Cleanup[] = [];

/** Registra una acción de limpieza best-effort (se ejecutan en orden inverso). */
export function onCleanup(label: string, fn: () => Promise<void> | void): void {
  cleanups.push({ label, fn });
}

async function runCleanups(): Promise<void> {
  for (const c of [...cleanups].reverse()) {
    try {
      await c.fn();
    } catch (err) {
      console.error(`  (cleanup "${c.label}" falló: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  cleanups.length = 0;
}

function printSummary(): void {
  const passed = records.filter((r) => r.ok).length;
  const failed = records.length - passed;
  const totalMs = records.reduce((acc, r) => acc + r.ms, 0);
  console.log("\n──────────────────────────────────────────────────");
  console.log(`Resumen E2E: ${passed} pasos ✓, ${failed} pasos ✗ (${(totalMs / 1000).toFixed(1)} s)`);
  for (const r of records) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error ?? ""}`}`);
  }
  console.log("──────────────────────────────────────────────────");
}

/** Termina la suite: cleanups + resumen + exit. */
export async function finishAndExit(code: number): Promise<never> {
  await runCleanups();
  printSummary();
  process.exit(code);
}

/**
 * Ejecuta un paso nombrado. Loguea ✓/✗ con duración. Un throw dentro del paso
 * aborta TODA la suite (ver política de fallo arriba).
 */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    records.push({ name, ok: true, ms });
    console.log(`✓ ${name} (${ms} ms)`);
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const message = err instanceof Error ? err.message : String(err);
    records.push({ name, ok: false, ms, error: message });
    console.error(`✗ ${name} (${ms} ms)`);
    console.error(`  ${message}`);
    if (err instanceof Error && !(err instanceof AssertionError) && err.stack !== undefined) {
      console.error(err.stack);
    }
    return finishAndExit(1);
  }
}

// ---------------------------------------------------------------------------
// Aserciones
// ---------------------------------------------------------------------------

export function fail(message: string): never {
  throw new AssertionError(message);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  }
}

export function assertOneOf<T>(actual: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(actual)) {
    fail(`${label}: esperado uno de ${JSON.stringify(allowed)}, recibido ${JSON.stringify(actual)}`);
  }
}

/** Diferencia absoluta ≤ tolerance (para comparaciones de timestamps en ms). */
export function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    fail(`${label}: |${actual} − ${expected}| = ${diff} excede tolerancia ${tolerance}`);
  }
}

// ---------------------------------------------------------------------------
// Espera / polling con backoff
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOpts {
  /** Tiempo máximo total (default 30 000 ms). */
  timeoutMs?: number;
  /** Delay inicial entre intentos (default 500 ms). */
  initialDelayMs?: number;
  /** Delay máximo entre intentos (default 3 000 ms). */
  maxDelayMs?: number;
  /** Factor de backoff (default 1.5). */
  factor?: number;
}

/**
 * Reintenta `probe` con backoff exponencial hasta que devuelva un valor
 * distinto de `undefined`, o falla con AssertionError al agotar el timeout.
 * Un throw dentro de `probe` aborta inmediatamente (no se reintenta), para que
 * errores duros (p. ej. 500) no se enmascaren como timeout.
 */
export async function pollUntil<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  opts: PollOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxDelay = opts.maxDelayMs ?? 3_000;
  const factor = opts.factor ?? 1.5;
  let delay = opts.initialDelayMs ?? 500;
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const value = await probe();
    if (value !== undefined) return value;
    const elapsed = Date.now() - startedAt;
    if (elapsed + delay > timeoutMs) {
      fail(`timeout de ${timeoutMs} ms (${attempts} intentos) esperando: ${description}`);
    }
    await sleep(delay);
    delay = Math.min(maxDelay, delay * factor);
  }
}

/**
 * Watchdog global: si la suite entera excede `ms`, aborta con exit 1.
 * (El timer queda referenciado a propósito; la suite SIEMPRE termina vía
 * finishAndExit → process.exit.)
 */
export function startWatchdog(ms: number): void {
  setTimeout(() => {
    console.error(`✗ WATCHDOG: la suite superó ${ms} ms; abortando.`);
    void finishAndExit(1);
  }, ms);
}
