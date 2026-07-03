/**
 * Paginación por cursor (contrato §17).
 *
 * Orden DESC por PK uuidv7 (más reciente primero); `next_cursor` es la PK del
 * último item devuelto (o null si no hay más). Query patrón:
 *   WHERE pk < :cursor ORDER BY pk DESC LIMIT :limit
 *
 * v1: el cursor ES el UUID tal cual, pero se trata como OPACO por convención
 * (los clientes no deben interpretarlo; el formato puede cambiar).
 */
import { domainError } from "./errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codifica una PK como cursor opaco (v1: passthrough). */
export function encodeCursor(id: string): string {
  return id;
}

/**
 * Decodifica y valida un cursor recibido del cliente.
 * Cursor malformado ⇒ DomainError `invalid_cursor` (400).
 */
export function decodeCursor(cursor: string): string {
  if (!UUID_RE.test(cursor)) {
    throw domainError("invalid_cursor", "El cursor de paginación no es válido.", {
      field: "cursor",
    });
  }
  return cursor.toLowerCase();
}
