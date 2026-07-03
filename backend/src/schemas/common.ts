/**
 * Schemas Zod compartidos (Problem RFC 7807, UUIDs, paginación) — contrato §17.
 * La API JSON habla snake_case (openapi.yaml); el código TS, camelCase.
 */
import { z } from "zod";
import { encodeCursor } from "../lib/cursor";

/** UUID (v7 en las PKs, pero se acepta cualquier UUID bien formado). */
export const UuidSchema = z.uuid();

/** RFC 7807 + extensión `errors[]` (openapi `Problem`). */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .array(
      z.object({
        code: z.string(),
        field: z.string().nullish(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Fábrica de query de paginación `{cursor?, limit?}` con CLAMP SILENCIOSO del
 * límite (§17: default 50, max 200; algunos recursos usan otros valores según
 * openapi — se parametrizan aquí). Valores no numéricos o fuera de rango no
 * producen 400: caen al default / se recortan a [1, maxLimit].
 * La validación del cursor (UUID) la hace `decodeCursor` en el service/repo.
 */
export function pageQuerySchema(defaultLimit = 50, maxLimit = 200) {
  return z.object({
    cursor: z.string().optional(),
    limit: z.coerce
      .number()
      .catch(defaultLimit)
      .default(defaultLimit)
      .transform((n) => Math.min(Math.max(Math.trunc(n), 1), maxLimit)),
  });
}

/** Query de paginación con los defaults del contrato (50, max 200). */
export const PageQuerySchema = pageQuerySchema();

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Schema de respuesta paginada: `{ items: T[], next_cursor: string|null }`. */
export function pageResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}

/**
 * Construye una página a partir de las filas devueltas por un repo que aplicó
 * `LIMIT :limit`: si llegaron exactamente `limit` filas puede haber más
 * (next_cursor = PK del último item); si llegaron menos, se acabó (null).
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  idOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor = rows.length === limit && last !== undefined ? encodeCursor(idOf(last)) : null;
  return { items: rows, nextCursor };
}
