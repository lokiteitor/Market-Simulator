/**
 * Aritmética de precios de instalaciones (economía de instalaciones, ADR-021).
 *
 * El precio de pasar del nivel `k` al `k+1` de una instalación es:
 *
 *   precio(k) = floor( basePriceCents × growthBps^k / 10000^k )
 *
 * Todo en BigInt con redondeo floor (sesgo conservador, igual que lib/money.ts).
 * `k = 0` (comprar la 1ª unidad) ⇒ precio = basePriceCents. Con `growthBps`
 * en base 10000 (10000 = ×1), un `growthBps` de 17000 encarece ×1.7 por nivel.
 * `max_level` acota `k` en el service; aquí solo se calcula.
 */

const BPS_DENOM = 10000n;

/**
 * Precio (en centavos) de subir la instalación del nivel `currentLevel` al
 * siguiente. `currentLevel` es 0 para la compra inicial (crea el nivel 1).
 */
export function installationUpgradePriceCents(
  basePriceCents: number,
  growthBps: number,
  currentLevel: number,
): number {
  if (!Number.isSafeInteger(basePriceCents) || basePriceCents <= 0) {
    throw new Error(
      `basePriceCents debe ser un entero positivo; recibido: ${basePriceCents}`,
    );
  }
  if (!Number.isSafeInteger(growthBps) || growthBps <= 0) {
    throw new Error(`growthBps debe ser un entero positivo; recibido: ${growthBps}`);
  }
  if (!Number.isSafeInteger(currentLevel) || currentLevel < 0) {
    throw new Error(
      `currentLevel debe ser un entero >= 0; recibido: ${currentLevel}`,
    );
  }
  const g = BigInt(growthBps);
  const k = BigInt(currentLevel);
  const numerator = BigInt(basePriceCents) * g ** k;
  const denominator = BPS_DENOM ** k;
  const price = numerator / denominator; // floor
  return Number(price);
}
