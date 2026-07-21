/**
 * Plan determinista del patrón oro (§banco central): sorteo del yacimiento,
 * reserva inicial del banco y paridad de la masa monetaria sembrada.
 */
import { goldWindow, parityCentsPerUnit, splitDeposit } from "../lib/gold";
import { randIntInclusive, rngFor } from "../lib/rng";

/** Clave RNG del sorteo del yacimiento (determinista con MASTER_SEED). */
export const GOLD_DEPOSIT_RNG_KEY = "gold_deposit";

export interface GoldPlan {
  /** Sorteo total D del yacimiento (qtyCent). */
  depositQtyCent: number;
  /** Reserva inicial del banco (carved de D). */
  bankGoldQtyCent: number;
  /** Yacimiento minable restante (D − reserva del banco). */
  minableQtyCent: number;
  /** Masa monetaria inicial: agentes de mercado + capital del banco. */
  initialMoneyCents: number;
  parityCentsPerUnit: number;
  windowBidCents: number;
  windowAskCents: number;
}

/**
 * Plan determinista del patrón oro (§banco central): sortea el yacimiento D
 * con rngFor(masterSeed, "gold_deposit"), reparte la reserva inicial del
 * banco y deriva la paridad de la masa TOTAL sembrada (agentes de mercado +
 * capital inicial del banco) contra el yacimiento completo D. Lanza si la
 * config produce paridad o bid < 1 (fail-fast, lib/gold.ts).
 */
export function buildGoldPlan(
  marketCapitalCents: number,
  opts: {
    masterSeed: number;
    gold: {
      depositMinQtyCent: number;
      depositMaxQtyCent: number;
      coverageRatioBps: number;
      windowSpreadBps: number;
      bankInitialReserveBps: number;
      bankInitialCapitalCents: number;
    };
  },
): GoldPlan {
  const rng = rngFor(opts.masterSeed, GOLD_DEPOSIT_RNG_KEY);
  const depositQtyCent = randIntInclusive(
    rng,
    opts.gold.depositMinQtyCent,
    opts.gold.depositMaxQtyCent,
  );
  const { bankGoldQtyCent, minableQtyCent } = splitDeposit(
    depositQtyCent,
    opts.gold.bankInitialReserveBps,
  );
  const initialMoneyCents = marketCapitalCents + opts.gold.bankInitialCapitalCents;
  const parity = parityCentsPerUnit(
    initialMoneyCents,
    depositQtyCent,
    opts.gold.coverageRatioBps,
  );
  const window = goldWindow(parity, opts.gold.windowSpreadBps);
  return {
    depositQtyCent,
    bankGoldQtyCent,
    minableQtyCent,
    initialMoneyCents,
    parityCentsPerUnit: parity,
    windowBidCents: window.bidCents,
    windowAskCents: window.askCents,
  };
}
