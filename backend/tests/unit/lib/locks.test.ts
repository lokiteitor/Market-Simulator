/**
 * Tests puros del mutex in-process por producto (src/lib/locks.ts), la PRIMERA
 * capa de serialización del matching (ADR-019). Sin DB: solo el ordenamiento
 * FIFO por clave, el paralelismo entre claves distintas y la limpieza del mapa.
 * La segunda capa (advisory lock cluster-wide) se ejercita en E2E contra la DB.
 */
import { describe, expect, test } from "bun:test";
import { activeLockCount, withProductLock } from "../../../src/lib/locks";

/** Promesa resoluble desde fuera (para orquestar el orden en los tests). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withProductLock", () => {
  test("serializa las secciones críticas del MISMO producto en orden FIFO", async () => {
    const order: number[] = [];
    const gate = deferred<void>();

    // El primero se queda esperando en `gate`; los siguientes NO deben empezar
    // hasta que termine, aunque se encolen de inmediato.
    const p1 = withProductLock("trigo", async () => {
      await gate.promise;
      order.push(1);
    });
    const p2 = withProductLock("trigo", async () => {
      order.push(2);
    });
    const p3 = withProductLock("trigo", async () => {
      order.push(3);
    });

    // Nada ha corrido todavía: el primero está bloqueado en el gate.
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("productos DISTINTOS corren en paralelo (no se serializan entre sí)", async () => {
    const started: string[] = [];
    const gateA = deferred<void>();

    // 'trigo' se bloquea; 'maiz' debe poder empezar y terminar igualmente.
    const pTrigo = withProductLock("trigo", async () => {
      started.push("trigo");
      await gateA.promise;
    });
    const pMaiz = withProductLock("maiz", async () => {
      started.push("maiz");
    });

    await pMaiz; // no depende de que 'trigo' termine.
    expect(started).toContain("maiz");
    gateA.resolve();
    await pTrigo;
  });

  test("un rechazo NO rompe la cadena para los siguientes del mismo producto", async () => {
    const ran: string[] = [];
    const p1 = withProductLock("trigo", async () => {
      ran.push("boom");
      throw new Error("boom");
    });
    const p2 = withProductLock("trigo", async () => {
      ran.push("ok");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2; // debe ejecutarse pese al rechazo anterior.
    expect(ran).toEqual(["boom", "ok"]);
  });

  test("las entradas ociosas se limpian del mapa (no crece sin límite)", async () => {
    await withProductLock("efimero", async () => undefined);
    // Sin trabajo pendiente, la clave se elimina.
    expect(activeLockCount()).toBe(0);
  });
});
