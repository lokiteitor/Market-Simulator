/** Normaliza cualquier error a `Problem` para el <ErrorBanner> (compartido por
 *  las páginas admin). Mismo criterio que DashboardPage. */
import { ApiError } from "../../api/client";
import type { Problem } from "../../api/types";

export function toProblem(err: unknown): Problem {
  if (err instanceof ApiError) return err.problem;
  return {
    type: "about:blank",
    title: "Error de comunicación",
    status: 0,
    detail: err instanceof Error ? err.message : "Fallo de red desconocido.",
  };
}
