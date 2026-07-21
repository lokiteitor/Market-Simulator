/**
 * Parseo genérico de archivos de configuración JSON validados con Zod.
 *
 * Patrón compartido por los configs de seed (`infra/seed-config.json`,
 * `infra/cities.json`): JSON.parse con error claro + safeParse con las issues
 * formateadas una por línea. Los mensajes (`<prefix>: JSON inválido: …` y
 * `<prefix>: estructura inválida:\n  - path: mensaje`) están fijados por los
 * tests unitarios del seed; no cambiar el formato.
 */
import type { z } from "zod";

export function parseJsonConfig<S extends z.ZodTypeAny>(
  rawJson: string,
  schema: S,
  prefix: string,
): z.infer<S> {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`${prefix}: JSON inválido: ${(err as Error).message}`);
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${prefix}: estructura inválida:\n${issues}`);
  }
  return parsed.data;
}
