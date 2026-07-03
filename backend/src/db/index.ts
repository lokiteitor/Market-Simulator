/**
 * Capa de acceso a datos (contrato §7).
 *
 * - `sql`: cliente postgres.js crudo (para queries SQL directas y healthz).
 * - `db`: instancia drizzle (driver postgres-js) con el schema tipado.
 * - `withTransaction(fn)`: única forma sancionada de abrir transacciones;
 *   los repositorios reciben el `Tx` como primer parámetro y NUNCA abren
 *   transacciones propias (contrato §0).
 * - `closeDb()`: cierre ordenado del pool (graceful shutdown).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

export const sql = postgres(config.databaseUrl, {
  // Pool moderado: core y worker comparten instancia de este módulo por proceso.
  max: 10,
  // Cierra conexiones ociosas a los 30s para no retener el pool completo.
  idle_timeout: 30,
  // Los NOTICE de Postgres no son errores; se silencian para no ensuciar stdout
  // (los logs de aplicación van por pino, contrato §0).
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export async function closeDb(): Promise<void> {
  // timeout en segundos: da margen a queries en vuelo antes de forzar cierre.
  await sql.end({ timeout: 5 });
}
