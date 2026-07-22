/**
 * transformMath.ts — lógica PURA de la pantalla de transformaciones [FE7]
 * (sin React): salario upfront estimado, huecos de capacidad y requisitos
 * de insumos vs. inventario.
 *
 * Salario (contrato del backend, specs/openapi.yaml + design doc):
 * el servidor cobra `wage_rate_cents_per_sec × duración_SIMULADA × ejecuciones`
 * por adelantado. El catálogo expone `duration_seconds` en segundos REALES,
 * así que la UI reconvierte con el factor de simulación (5×) para estimar el
 * importe. Es una estimación: el importe exacto lo calcula el servidor
 * (posible ±1 s por redondeo del catálogo).
 */
import type {
  Deposit,
  InstallationStatus,
  InventoryPosition,
  Recipe,
} from "../../api/types";
import { realToSimSeconds } from "../market/simTime";

/**
 * Salario total upfront estimado (centavos):
 * rate × duración_sim(duration_seconds reales × factor) × ejecuciones.
 * Producto exacto con BigInt.
 */
export function estimateWageCents(recipe: Recipe, executions: number): number {
  const simSeconds = realToSimSeconds(recipe.duration_seconds);
  return Number(
    BigInt(recipe.wage_rate_cents_per_sec) *
      BigInt(simSeconds) *
      BigInt(executions),
  );
}

/**
 * Yacimiento del producto de salida de la receta, o `null` si el producto es
 * inagotable (no aparece en GET /catalog/deposits). Solo los recursos
 * geológicos finitos (ADR-023) tienen yacimiento.
 */
export function depositForRecipe(
  recipe: Recipe,
  deposits: readonly Deposit[],
): Deposit | null {
  return (
    deposits.find((d) => d.product_id === recipe.output_product_id) ?? null
  );
}

/**
 * Salida efectiva estimada aplicando el rendimiento del yacimiento:
 * floor(output_qty_cent × ejecuciones × yield_bps / 10000). Es una COTA
 * SUPERIOR: el rendimiento decae con cada extracción, así que las últimas
 * ejecuciones rinden algo menos que el `yield_bps` observado ahora.
 * Valorar la receta con la salida nominal sobreestima la producción.
 */
export function effectiveOutputCent(
  outputQtyCent: number,
  executions: number,
  yieldBps: number,
): number {
  return Number(
    (BigInt(outputQtyCent) * BigInt(executions) * BigInt(yieldBps)) / 10_000n,
  );
}

/** Huecos libres de una instalación: `available_slots` o `level - running`. */
export function availableSlots(installation: InstallationStatus): number {
  return installation.available_slots ?? Math.max(0, installation.level - installation.running);
}

export interface InputRequirement {
  productId: string;
  /** qty_required_cent × ejecuciones (centésimas). */
  requiredCent: number;
  /** Disponible en inventario (centésimas). */
  availableCent: number;
  /** `true` si el inventario cubre lo requerido. */
  ok: boolean;
}

/**
 * Insumos totales requeridos por `executions` ejecuciones de la receta,
 * comparados con el inventario disponible del agente.
 */
export function inputRequirements(
  recipe: Recipe,
  executions: number,
  inventory: readonly InventoryPosition[],
): InputRequirement[] {
  const availableByProduct = new Map<string, number>();
  for (const pos of inventory) {
    availableByProduct.set(pos.product_id, pos.qty_available_cent);
  }
  return recipe.inputs.map((input) => {
    const requiredCent = input.qty_required_cent * executions;
    const availableCent = availableByProduct.get(input.product_id) ?? 0;
    return {
      productId: input.product_id,
      requiredCent,
      availableCent,
      ok: availableCent >= requiredCent,
    };
  });
}
