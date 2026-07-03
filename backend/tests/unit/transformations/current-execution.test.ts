/**
 * Tests puros de current_execution calculada (contrato §10.9) — [M4].
 *
 * El avance NO se persiste: para un proceso running se calcula
 *   min(executions_planned, floor(elapsedSimSeconds / durationSimSeconds) + 1)
 * Los tests construyen started_at con simSecondsToRealMs para ser
 * independientes del SIM_TIME_FACTOR configurado.
 */
import { describe, expect, test } from "bun:test";
import { simSecondsToRealMs } from "../../../src/lib/simtime";
import { currentExecutionAt } from "../../../src/services/transformation-service";

const NOW = new Date("2026-07-03T12:00:00.000Z");
const DURATION_SIM_SECONDS = 60;

function runningProcess(elapsedSimSeconds: number, executionsPlanned: number) {
  return {
    status: "running" as const,
    startedAt: new Date(NOW.getTime() - simSecondsToRealMs(elapsedSimSeconds)),
    executionsPlanned,
    currentExecution: 1,
  };
}

describe("currentExecutionAt (running)", () => {
  test("recién iniciado ⇒ ejecución 1", () => {
    expect(currentExecutionAt(runningProcess(0, 3), DURATION_SIM_SECONDS, NOW)).toBe(1);
  });

  test("a mitad de la primera ejecución ⇒ 1", () => {
    expect(currentExecutionAt(runningProcess(30, 3), DURATION_SIM_SECONDS, NOW)).toBe(1);
  });

  test("justo al terminar la primera ejecución ⇒ 2 (floor(60/60)+1)", () => {
    expect(currentExecutionAt(runningProcess(60, 3), DURATION_SIM_SECONDS, NOW)).toBe(2);
  });

  test("dentro de la tercera ejecución ⇒ 3", () => {
    expect(currentExecutionAt(runningProcess(125, 3), DURATION_SIM_SECONDS, NOW)).toBe(3);
  });

  test("vencido pero sin materializar ⇒ clamp a executions_planned", () => {
    expect(currentExecutionAt(runningProcess(10_000, 3), DURATION_SIM_SECONDS, NOW)).toBe(3);
  });

  test("un solo executions_planned nunca supera 1", () => {
    expect(currentExecutionAt(runningProcess(999, 1), DURATION_SIM_SECONDS, NOW)).toBe(1);
  });

  test("reloj adelantado (started_at en el futuro) ⇒ elapsed clamp a 0 ⇒ 1", () => {
    const p = {
      status: "running" as const,
      startedAt: new Date(NOW.getTime() + 5_000),
      executionsPlanned: 3,
      currentExecution: 1,
    };
    expect(currentExecutionAt(p, DURATION_SIM_SECONDS, NOW)).toBe(1);
  });

  test("duración inválida (<= 0) degrada a 1 sin dividir por cero", () => {
    expect(currentExecutionAt(runningProcess(120, 3), 0, NOW)).toBe(1);
  });
});

describe("currentExecutionAt (estados terminales: usa el valor persistido)", () => {
  test("completed ⇒ executions_planned persistido al materializar", () => {
    const p = {
      status: "completed" as const,
      startedAt: new Date(NOW.getTime() - 1_000_000),
      executionsPlanned: 4,
      currentExecution: 4,
    };
    expect(currentExecutionAt(p, DURATION_SIM_SECONDS, NOW)).toBe(4);
  });

  test("cancelled ⇒ valor congelado (1, §10.9/§10.10)", () => {
    const p = {
      status: "cancelled" as const,
      startedAt: new Date(NOW.getTime() - 1_000_000),
      executionsPlanned: 4,
      currentExecution: 1,
    };
    expect(currentExecutionAt(p, DURATION_SIM_SECONDS, NOW)).toBe(1);
  });
});
