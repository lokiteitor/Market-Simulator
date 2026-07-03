/**
 * labels.ts — etiquetas en español del catálogo.
 * Archivo hoja compartido: lo importan CatalogPage y las páginas de mercado
 * (la categoría del producto se muestra con <Badge kind={category}>).
 */
import type { ProductCategory } from "../../api/types";

export const PRODUCT_CATEGORY_LABEL: Record<ProductCategory, string> = {
  raw_primary: "Materia prima",
  intermediate: "Intermedio",
  final_consumption: "Consumo final",
};

/** Orden canónico de categorías para agrupaciones (cadena productiva). */
export const PRODUCT_CATEGORY_ORDER: readonly ProductCategory[] = [
  "raw_primary",
  "intermediate",
  "final_consumption",
];
