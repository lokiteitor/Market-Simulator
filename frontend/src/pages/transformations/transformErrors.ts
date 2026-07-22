/**
 * transformErrors.ts — lógica PURA (sin React): traducción de los códigos de
 * error de dominio de POST /transformations (errors[].code del Problem RFC
 * 7807) a mensajes accionables en español. `null` para códigos desconocidos
 * (el llamador cae al banner con el mensaje crudo del servidor).
 */

const ERROR_MESSAGE: Record<string, string> = {
  // ADR-023: el yacimiento del producto de salida está a 0.
  resource_depleted:
    "El yacimiento del producto está agotado: la receta ya no produce nada.",
  // ADR-021: sin instalación comprada del tipo de la receta.
  insufficient_capacity:
    "No tienes la instalación de esta receta: cómprala en la pantalla de Instalaciones.",
  // ADR-021: todos los huecos del tipo están en uso (running >= level).
  recipe_capacity_saturated:
    "Instalación saturada: espera a que termine algún proceso del tipo o mejora su nivel.",
  insufficient_capital:
    "Capital insuficiente para pagar el salario upfront del proceso.",
  insufficient_inventory:
    "Insumos insuficientes en inventario para las ejecuciones planificadas.",
  unknown_recipe: "La receta no existe en el catálogo de esta corrida.",
  agent_bankrupt:
    "El agente está en quiebra: las operaciones de escritura están bloqueadas.",
};

/** Códigos que implican que la capacidad/estado cambió por debajo de la UI. */
export const CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set([
  "insufficient_capacity",
  "recipe_capacity_saturated",
]);

/** Mensaje en español para un código de dominio, o `null` si no hay mapeo. */
export function transformationErrorMessage(code: string): string | null {
  return ERROR_MESSAGE[code] ?? null;
}
