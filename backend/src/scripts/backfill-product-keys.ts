/**
 * Backfill de `product.key` para bases de datos creadas ANTES de que el schema
 * incluyera la columna (el DDL solo se aplica en volúmenes nuevos vía
 * docker-entrypoint-initdb.d, así que una DB viva no la tiene).
 *
 *   bun src/scripts/backfill-product-keys.ts
 *
 * Idempotente: añade la columna si falta, rellena `key` mapeando por `name`
 * desde `infra/seed-config.json` (config.seedConfigPath) y aplica NOT NULL +
 * UNIQUE al final. Si algún producto de la DB no aparece en el seed-config,
 * aborta con la lista (rollback completo) — mejor fallar que dejar keys nulas.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config";
import { closeDb, sql } from "../db";
import { logger } from "../observability/logger";
import { parseSeedConfig } from "../seed";

const log = logger.child({ component: "backfill-product-keys" });

const seedConfigPath = resolve(process.cwd(), config.seedConfigPath);
const rawJson = await readFile(seedConfigPath, "utf8");
const { products } = parseSeedConfig(rawJson);
const keyByName = new Map(products.map((p) => [p.name, p.key]));

try {
  await sql.begin(async (tx) => {
    const columns = await tx`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'product' AND column_name = 'key'
    `;
    if (columns.length === 0) {
      await tx`ALTER TABLE product ADD COLUMN key TEXT`;
      log.info("columna product.key creada");
    }

    const rows = await tx<{ productId: string; name: string }[]>`
      SELECT product_id AS "productId", name FROM product WHERE key IS NULL
    `;
    const unmatched: string[] = [];
    for (const row of rows) {
      const key = keyByName.get(row.name);
      if (key === undefined) {
        unmatched.push(row.name);
        continue;
      }
      await tx`UPDATE product SET key = ${key} WHERE product_id = ${row.productId}`;
    }
    if (unmatched.length > 0) {
      throw new Error(
        `productos sin key en el seed-config (¿nombres cambiados?): ${unmatched.join(", ")}`,
      );
    }

    await tx`ALTER TABLE product ALTER COLUMN key SET NOT NULL`;
    const constraints = await tx`
      SELECT 1 FROM pg_constraint WHERE conname = 'product_key_key'
    `;
    if (constraints.length === 0) {
      await tx`ALTER TABLE product ADD CONSTRAINT product_key_key UNIQUE (key)`;
    }
    log.info({ backfilled: rows.length }, "backfill de product.key completado");
  });
} catch (err) {
  log.error({ err }, "backfill de product.key fallido; ningún cambio aplicado");
  await closeDb();
  process.exit(1);
}

await closeDb();
process.exit(0);
