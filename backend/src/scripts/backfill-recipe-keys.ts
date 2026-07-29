/**
 * Backfill de `recipe.key` para bases de datos creadas ANTES de que el schema
 * incluyera la columna (el DDL solo se aplica en volúmenes nuevos vía
 * docker-entrypoint-initdb.d, así que una DB viva no la tiene).
 *
 *   bun src/scripts/backfill-recipe-keys.ts
 *
 * Gemelo de `backfill-product-keys.ts` y por el mismo motivo: la clave estable
 * es lo que permite a un cliente nombrar una receta concreta (bots-v2 declara
 * sus oficios así). Idempotente: añade la columna si falta, rellena `key`
 * mapeando por `name` desde `infra/seed-config.json` (config.seedConfigPath) y
 * aplica NOT NULL + UNIQUE al final. Si alguna receta de la DB no aparece en el
 * seed-config, aborta con la lista (rollback completo) — mejor fallar que dejar
 * keys nulas, porque una key nula rompe la resolución de oficios en silencio.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config";
import { closeDb, sql } from "../db";
import { logger } from "../observability/logger";
import { parseSeedConfig } from "../seed";

const log = logger.child({ component: "backfill-recipe-keys" });

const seedConfigPath = resolve(process.cwd(), config.seedConfigPath);
const rawJson = await readFile(seedConfigPath, "utf8");
const { recipes } = parseSeedConfig(rawJson);
const keyByName = new Map(recipes.map((r) => [r.name, r.key]));

try {
  await sql.begin(async (tx) => {
    const columns = await tx`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'recipe' AND column_name = 'key'
    `;
    if (columns.length === 0) {
      await tx`ALTER TABLE recipe ADD COLUMN key TEXT`;
      log.info("columna recipe.key creada");
    }

    const rows = await tx<{ recipeId: string; name: string }[]>`
      SELECT recipe_id AS "recipeId", name FROM recipe WHERE key IS NULL
    `;
    const unmatched: string[] = [];
    for (const row of rows) {
      const key = keyByName.get(row.name);
      if (key === undefined) {
        unmatched.push(row.name);
        continue;
      }
      await tx`UPDATE recipe SET key = ${key} WHERE recipe_id = ${row.recipeId}`;
    }
    if (unmatched.length > 0) {
      throw new Error(
        `recetas sin key en el seed-config (¿nombres cambiados?): ${unmatched.join(", ")}`,
      );
    }

    await tx`ALTER TABLE recipe ALTER COLUMN key SET NOT NULL`;
    const constraints = await tx`
      SELECT 1 FROM pg_constraint WHERE conname = 'recipe_key_key'
    `;
    if (constraints.length === 0) {
      await tx`ALTER TABLE recipe ADD CONSTRAINT recipe_key_key UNIQUE (key)`;
    }
    log.info({ backfilled: rows.length }, "backfill de recipe.key completado");
  });
} catch (err) {
  log.error({ err }, "backfill de recipe.key fallido; ningún cambio aplicado");
  await closeDb();
  process.exit(1);
}

await closeDb();
process.exit(0);
