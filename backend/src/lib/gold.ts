/**
 * Aritmética del Patrón Oro y Ventanilla de Convertibilidad (§política monetaria).
 *
 * Cantidades de oro: BIGINT en centésimas de unidad (qtyCent).
 * Dinero: BIGINT en centavos (cents).
 * Toda la aritmética de conversión y paridad pasa por BigInt para evitar pérdida de
 * precisión, con redondeo SIEMPRE floor (división entera de BigInt).
 */

/**
 * Reparte el yacimiento total D entre la reserva inicial del banco y el remanente minable.
 * Reserva inicial del banco = floor(D * bankInitialReserveBps / 10000).
 */
export function splitDeposit(
  depositQtyCent: number,
  bankInitialReserveBps: number
): { bankGoldQtyCent: number; minableQtyCent: number } {
  const deposit = BigInt(depositQtyCent);
  const bps = BigInt(bankInitialReserveBps);
  const bankGold = (deposit * bps) / 10000n;
  const minable = deposit - bankGold;
  return {
    bankGoldQtyCent: Number(bankGold),
    minableQtyCent: Number(minable),
  };
}

/**
 * Calcula la paridad de convertibilidad (cents por unidad entera de oro).
 * parity = floor(M0 * coverageRatioBps / (100 * D)).
 * Lanza si la paridad calculada es menor a 1 centavo (fail-fast).
 */
export function parityCentsPerUnit(
  initialMoneyCents: number,
  depositQtyCent: number,
  coverageRatioBps: number
): number {
  const m0 = BigInt(initialMoneyCents);
  const d = BigInt(depositQtyCent);
  const coverage = BigInt(coverageRatioBps);
  if (d === 0n) {
    throw new Error("parityCentsPerUnit: depositQtyCent no puede ser 0");
  }
  const denominator = 100n * d;
  const parity = (m0 * coverage) / denominator;
  if (parity < 1n) {
    throw new Error(
      `paridad calculada menor a 1 centavo: ${parity}. Masa inicial o cobertura insuficiente para el yacimiento.`
    );
  }
  return Number(parity);
}

/**
 * Calcula la banda de precios de la ventanilla (compra/bid y venta/ask).
 * half = floor(parity * windowSpreadBps / 10000)
 * bid = parity - half
 * ask = parity + half
 * Lanza si window_bid es menor a 1 centavo (fail-fast).
 */
export function goldWindow(
  parity: number,
  windowSpreadBps: number
): { bidCents: number; askCents: number } {
  const p = BigInt(parity);
  const spread = BigInt(windowSpreadBps);
  const half = (p * spread) / 10000n;
  const bid = p - half;
  const ask = p + half;
  if (bid < 1n) {
    throw new Error(
      `window_bid calculado menor a 1 centavo: ${bid}. Spread excesivo o paridad baja.`,
    );
  }
  return {
    bidCents: Number(bid),
    askCents: Number(ask),
  };
}

/**
 * Calcula la capacidad máxima de emisión basada en las reservas del banco y la cobertura.
 * value_cents = floor(goldAvailable * parityCentsPerUnit / 100)
 * capacity = floor(value_cents * 10000 / coverageRatioBps)
 */
export function issuanceCapacityCents(
  goldAvailable: number,
  parityCentsPerUnit: number,
  coverageRatioBps: number
): number {
  const gold = BigInt(goldAvailable);
  const parity = BigInt(parityCentsPerUnit);
  const coverage = BigInt(coverageRatioBps);
  if (coverage === 0n) {
    throw new Error("issuanceCapacityCents: coverageRatioBps no puede ser 0");
  }
  const goldValueCents = (gold * parity) / 100n;
  const capacity = (goldValueCents * 10000n) / coverage;
  return Number(capacity);
}

/**
 * Clampea la cantidad planificada a producir contra el remanente disponible en el yacimiento.
 * Retorna la cantidad real a minar y el remanente posterior.
 */
export function clampMint(
  qtyRemainingCent: number,
  qtyPlannedCent: number
): { mintedQtyCent: number; remainingAfterCent: number } {
  if (!Number.isSafeInteger(qtyRemainingCent) || qtyRemainingCent < 0) {
    throw new Error(
      `clampMint: qtyRemainingCent debe ser un entero >= 0; recibido: ${qtyRemainingCent}`,
    );
  }
  if (!Number.isSafeInteger(qtyPlannedCent) || qtyPlannedCent < 0) {
    throw new Error(
      `clampMint: qtyPlannedCent debe ser un entero >= 0; recibido: ${qtyPlannedCent}`,
    );
  }
  const remaining = BigInt(qtyRemainingCent);
  const planned = BigInt(qtyPlannedCent);
  const minted = remaining < planned ? remaining : planned;
  const after = remaining - minted;
  return {
    mintedQtyCent: Number(minted),
    remainingAfterCent: Number(after),
  };
}
