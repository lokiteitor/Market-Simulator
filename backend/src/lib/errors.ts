/**
 * Errores de dominio y serialización RFC 7807 (contrato §6).
 *
 * Los códigos son ESTABLES: forman parte del contrato con los clientes
 * (campo `errors[].code` y el `type` URI del Problem+JSON).
 * El mapeo global de errores a respuestas HTTP vive en `src/app.ts` [M10].
 */

/**
 * Códigos estables → status HTTP y título por defecto.
 *
 * Nota: `client_order_id_replay` no es un error para el cliente — señala al
 * controller que debe responder 200 con la orden ya existente (§10.7).
 * `invalid_cursor` (400) valida cursores de paginación (§17).
 */
export const ErrorCodes = {
  insufficient_capital: { status: 422, title: "Capital insuficiente" },
  insufficient_inventory: { status: 422, title: "Inventario insuficiente" },
  insufficient_capacity: { status: 422, title: "Capacidad no instalada" },
  recipe_capacity_saturated: { status: 422, title: "Capacidad de receta saturada" },
  ttl_out_of_range: { status: 422, title: "TTL fuera de rango" },
  agent_bankrupt: { status: 403, title: "Agente en quiebra" },
  not_owner: { status: 403, title: "El recurso pertenece a otro agente" },
  unknown_product: { status: 404, title: "Producto desconocido" },
  unknown_order: { status: 404, title: "Orden desconocida" },
  unknown_recipe: { status: 404, title: "Receta desconocida" },
  unknown_process: { status: 404, title: "Proceso desconocido" },
  unknown_agent: { status: 404, title: "Agente desconocido" },
  username_taken: { status: 409, title: "Nombre de usuario en uso" },
  conflict_state: { status: 409, title: "Estado en conflicto" },
  invalid_credentials: { status: 401, title: "Credenciales inválidas" },
  invalid_token: { status: 401, title: "Token inválido" },
  invalid_cursor: { status: 400, title: "Cursor de paginación inválido" },
  client_order_id_replay: { status: 200, title: "Orden ya registrada (client_order_id repetido)" },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export interface ProblemErrorItem {
  code: string;
  field?: string;
  message: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly field?: string;
  readonly errors?: ProblemErrorItem[];

  constructor(opts: {
    code: ErrorCode;
    status: number;
    title: string;
    detail: string;
    field?: string;
    errors?: ProblemErrorItem[];
  }) {
    super(opts.detail);
    this.name = "DomainError";
    this.code = opts.code;
    this.status = opts.status;
    this.title = opts.title;
    this.detail = opts.detail;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.errors !== undefined) this.errors = opts.errors;
  }
}

/**
 * Fábrica de conveniencia: status y title salen de `ErrorCodes[code]`.
 * Equivalente a `new DomainError({...})` con menos ruido en los services.
 */
export function domainError(
  code: ErrorCode,
  detail: string,
  opts?: { field?: string; errors?: ProblemErrorItem[] },
): DomainError {
  const { status, title } = ErrorCodes[code];
  return new DomainError({ code, status, title, detail, ...opts });
}

/** Forma RFC 7807 con extensión `errors[]` (openapi `Problem`). */
export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: ProblemErrorItem[];
}

/**
 * Serializa un DomainError a Problem+JSON (RFC 7807).
 * `type` = "https://errors.mercado-agricola/<code-kebab>".
 * Si el error no trae `errors[]`, se sintetiza una entrada con su code/field/detail
 * para que los clientes siempre dispongan del código máquina.
 */
export function toProblemJson(err: DomainError, instancePath?: string): ProblemJson {
  const problem: ProblemJson = {
    type: `https://errors.mercado-agricola/${err.code.replaceAll("_", "-")}`,
    title: err.title,
    status: err.status,
    detail: err.detail,
    errors:
      err.errors ??
      [{ code: err.code, ...(err.field !== undefined ? { field: err.field } : {}), message: err.detail }],
  };
  if (instancePath !== undefined) problem.instance = instancePath;
  return problem;
}
