/**
 * Ciudades-consumidor (rol `city`): schema y parseo de `infra/cities.json`,
 * fuente única compartida con el binario bots-ciudad. No pasan por el
 * seed-config del catálogo (no tienen capacidades).
 */
import { z } from "zod";
import { parseJsonConfig } from "../lib/json-config";

const CitySchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Solo letras, dígitos y . _ -"),
  display: z.string().optional(),
  population_weight: z.number().int().positive(),
});

const CitiesConfigSchema = z.object({
  cities: z.array(CitySchema).min(1),
});

export type CitiesConfig = z.infer<typeof CitiesConfigSchema>;

/** Parsea y valida infra/cities.json (schema + usernames únicos). */
export function parseCitiesConfig(rawJson: string): CitiesConfig {
  const cfg = parseJsonConfig(rawJson, CitiesConfigSchema, "cities");
  const seen = new Set<string>();
  for (const c of cfg.cities) {
    if (seen.has(c.username)) {
      throw new Error(`cities: username duplicado: "${c.username}"`);
    }
    seen.add(c.username);
  }
  return cfg;
}
