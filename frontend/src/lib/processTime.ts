/**
 * processTime.ts — progreso temporal de procesos y reloj de re-render.
 * Compartido por DashboardPage y TransformationsPage (antes duplicado).
 */
import { useEffect, useState } from "react";

import type { TransformationProcess } from "../api/types";

/** Progreso temporal de un proceso: transcurrido vs. duración total. */
export function processProgress(
  p: TransformationProcess,
  nowMs: number,
): { value: number; max: number } {
  const start = Date.parse(p.started_at);
  const end = Date.parse(p.expected_end_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return { value: 0, max: 1 };
  }
  const max = end - start;
  const value = Math.min(Math.max(nowMs - start, 0), max);
  return { value, max };
}

/** Timestamp "ahora" que se refresca cada `intervalMs` (re-render periódico). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
