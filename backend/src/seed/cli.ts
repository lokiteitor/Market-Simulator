/**
 * Entrypoint CLI del seed (`bun src/seed/cli.ts`, script `bun run seed`).
 * Toda la lógica vive en `run-seed.ts`; aquí solo el ciclo de vida del
 * proceso (cierre del pool y exit codes).
 */
import { closeDb } from "../db";
import { logger } from "../observability/logger";
import { runSeed } from "./run-seed";

if (import.meta.main) {
  try {
    await runSeed();
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Seed falló — rollback total (transacción única)");
    await closeDb().catch(() => {
      // El pool puede no haberse abierto nunca; el exit code ya refleja el fallo.
    });
    process.exit(1);
  }
}
