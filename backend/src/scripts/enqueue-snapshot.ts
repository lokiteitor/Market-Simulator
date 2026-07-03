/**
 * Encola un job de snapshot on-demand en la cola `snapshot` y sale
 * (contrato §14). Lo referencia package.json:
 *
 *   bun run snapshot [nota opcional...]
 *
 * La nota (argv restante, unido con espacios) se persiste en
 * market_snapshot.note y en el payload del evento snapshot_taken.
 * El job lo procesa el Worker (src/worker.ts → SnapshotRunner).
 */
import { Queue } from "bullmq";
import { logger } from "../observability/logger";
import { SNAPSHOT_QUEUE, bullmqConnectionOptions } from "../workers/queues";
import type { SnapshotJobData } from "../workers/queues";

const log = logger.child({ component: "enqueue-snapshot" });

// `bun run snapshot -- mi nota` o `bun run snapshot mi nota`: se ignora el
// separador "--" que npm/bun pueden dejar pasar en argv.
const note = process.argv
  .slice(2)
  .filter((a) => a !== "--")
  .join(" ")
  .trim();

const queue = new Queue<SnapshotJobData>(SNAPSHOT_QUEUE, {
  connection: bullmqConnectionOptions(),
});

try {
  const job = await queue.add(
    "snapshot",
    { note: note.length > 0 ? note : null },
    { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
  );
  log.info({ jobId: job.id, note: note.length > 0 ? note : null }, "job de snapshot encolado");
} catch (err) {
  log.error({ err }, "no se pudo encolar el snapshot");
  await queue.close();
  process.exit(1);
}

// queue.close() cierra también la conexión Redis que BullMQ creó.
await queue.close();
process.exit(0);
