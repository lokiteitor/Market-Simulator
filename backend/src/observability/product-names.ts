/**
 * Cache id→nombre de producto para etiquetar métricas con nombres legibles.
 *
 * Las métricas de producto llevan dos labels: `product` (nombre, el que se
 * agrupa en Grafana) y `product_id` (UUID, para poder cruzar con la DB). Los
 * contadores event-driven (trades, volumen, producción) solo conocen el UUID en
 * el punto de emisión, de ahí esta cache.
 *
 * El catálogo es prácticamente estático (se siembra con `seed.ts`), así que se
 * refresca con un TTL largo. Si el producto no está en cache (alta reciente o
 * DB caída), se degrada al UUID como nombre: se pierde legibilidad, nunca la
 * métrica.
 *
 * Usable desde core y worker (ambos tienen pool de DB).
 */
import { asc } from "drizzle-orm";
import { withTransaction } from "../db";
import { product } from "../db/schema";
import { logger } from "./logger";

const log = logger.child({ component: "product-names" });

const TTL_MS = 5 * 60_000;
/** Guarda contra refrescar en cada emisión si un id sigue sin aparecer en la DB. */
const MISS_RETRY_MS = 30_000;

let names = new Map<string, string>();
let loadedAt = 0;
let inFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  // Coalescer refrescos concurrentes en una sola consulta.
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await withTransaction(async (tx) =>
        tx.select({ productId: product.productId, name: product.name }).from(product).orderBy(asc(product.name)),
      );
      names = new Map(rows.map((r) => [r.productId, r.name]));
      loadedAt = Date.now();
    } catch (err) {
      // Se conserva la cache previa; el caller caerá al UUID si está vacía.
      log.warn({ err }, "fallo refrescando el catálogo de productos para métricas");
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Labels de producto para prom-client. Refresca la cache si está caducada o si
 * el id es desconocido (producto dado de alta después del último refresco).
 */
export async function productLabels(
  productId: string,
): Promise<{ product: string; product_id: string }> {
  const age = Date.now() - loadedAt;
  const miss = !names.has(productId) && age >= MISS_RETRY_MS;
  if (age >= TTL_MS || miss) await refresh();
  return { product: names.get(productId) ?? productId, product_id: productId };
}
