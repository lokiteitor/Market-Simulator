/**
 * Mutex in-process por producto (contrato §10.2).
 *
 * `withProductLock(productId, fn)` serializa las secciones críticas del
 * matching (placeOrder / cancelOrder) por producto: mantiene un mapa de
 * cadenas de promesas (FIFO) por clave. Las entradas sin trabajo pendiente
 * se eliminan del mapa para no crecer sin límite.
 *
 * Nota: es un lock IN-PROCESS (el Core corre como proceso único, ADR de
 * arquitectura). El worker de expiración NO usa este lock: sus transacciones
 * cortas por orden con FOR UPDATE de la fila bastan.
 */

interface ChainEntry {
  /** Cola FIFO: promesa que se resuelve cuando termina el último trabajo encolado. */
  tail: Promise<void>;
  /** Trabajos encolados aún no terminados (para limpieza de entradas ociosas). */
  pending: number;
}

const chains = new Map<string, ChainEntry>();

/**
 * Ejecuta `fn` en exclusión mutua con cualquier otro `withProductLock` de la
 * misma clave, en orden FIFO de llegada. Propaga el resultado/rechazo de `fn`;
 * un rechazo NO rompe la cadena para los siguientes en cola.
 */
export async function withProductLock<T>(productId: string, fn: () => Promise<T>): Promise<T> {
  const existing = chains.get(productId);
  const entry: ChainEntry = existing ?? { tail: Promise.resolve(), pending: 0 };
  if (existing === undefined) chains.set(productId, entry);
  entry.pending += 1;

  const run = entry.tail.then(fn);
  // La nueva cola espera a que ESTE trabajo termine (éxito o error) y luego
  // hace la contabilidad de limpieza; los errores no se propagan por la cadena.
  entry.tail = run.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    entry.pending -= 1;
    if (entry.pending === 0 && chains.get(productId) === entry) {
      chains.delete(productId);
    }
  });

  return run;
}

/** Nº de claves con trabajo pendiente (diagnóstico/tests). */
export function activeLockCount(): number {
  return chains.size;
}
