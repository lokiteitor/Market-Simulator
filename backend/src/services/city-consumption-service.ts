/**
 * CityConsumptionService — demanda urbana endógena (ADR-029).
 *
 * Es el ÚNICO sumidero de bienes del sistema: hasta ahora lo que compraba una
 * ciudad se quedaba en su inventario para siempre y su demanda no dependía de lo
 * que ya tenía. Aquí, en cada pasada y por ciudad:
 *
 *   1. absorbe la `vivienda` comprada  → destruye el lote y suma habitantes;
 *   2. aplica el decaimiento de población (con suelo en la población inicial),
 *      que es lo que obliga a seguir construyendo para no encogerse;
 *   3. calcula la necesidad de la cesta ∝ población × Δt simulado;
 *   4. la consume best-effort (DESTRUYE inventario) y anota el déficit.
 *
 * Las tres reglas de cálculo son funciones PURAS al final del fichero, con el
 * mismo criterio que `splitIncomeByWeight` / `splitFifo`: la aritmética entera
 * es donde se esconden los errores, así que se testea sin DB.
 *
 * NO toca dinero: la conservación monetaria no entra en juego aquí. El dinero de
 * la ciudad se fue cuando compró; esto solo retira las unidades del mundo.
 *
 * Cada ciudad se procesa en su PROPIA transacción (la abre el sweeper): así el
 * lock de su fila no se solapa con el de las otras 49 ni con las órdenes en
 * vuelo, y un fallo aislado no tumba la pasada completa.
 */
import { config } from "../config";
import type { Tx } from "../db";
import { appendEvent } from "../lib/event-log";
import { agentRepository } from "../repositories/agent-repository";
import { catalogRepository } from "../repositories/catalog-repository";
import { inventoryService } from "./inventory-service";

/** Segundos simulados en un día simulado (base del decaimiento). */
const SIM_SECONDS_PER_DAY = 86_400;
/** Segundos simulados en una hora simulada (base del presupuesto per cápita). */
const SIM_SECONDS_PER_HOUR = 3_600;
/** Centésimas de unidad en una unidad (las cantidades son enteros ×100). */
const QTY_CENT_PER_UNIT = 100;
/**
 * "Todo el stock disponible" para `consumeAvailableFifoUpTo`, que reparte
 * `min(pedido, pool)`: pedir el máximo entero seguro equivale a vaciar el pool.
 */
const TODO_EL_STOCK = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Cálculo puro
// ---------------------------------------------------------------------------

export interface PopulationDynamicsParams {
  /** Habitantes por unidad ENTERA de vivienda absorbida. */
  habitantsPerHousing: number;
  /** Decaimiento por día simulado, en bps de la población. */
  decayBpsPerSimDay: number;
  /** Suelo: la población nunca baja de aquí (habitualmente la inicial). */
  floor: number;
}

export interface PopulationDynamics {
  populationAfter: number;
  /** Habitantes ganados por la vivienda absorbida. */
  habitantsGained: number;
  /** Habitantes perdidos por decaimiento, YA recortados por el suelo. */
  habitantsLost: number;
}

/**
 * Dinámica de población PURA de una pasada: decae primero sobre la población de
 * entrada y suma después los habitantes de la vivienda absorbida (una vivienda
 * comprada en esta misma pasada no debe decaer en ella).
 *
 * El decaimiento es `floor(pob × bps × Δt_días / 10000)`, entero y truncado
 * hacia abajo: con poblaciones pequeñas y Δt cortos redondea a 0 y la ciudad no
 * pierde a nadie, que es el sesgo conservador deseado (no inventa hambre).
 *
 * El suelo se aplica solo al decaimiento, NO al total: una ciudad puede estar
 * por encima del suelo gracias a su vivienda y seguir creciendo sin límite.
 */
export function applyPopulationDynamics(
  population: number,
  housingQtyCentAbsorbed: number,
  elapsedSimSeconds: number,
  p: PopulationDynamicsParams,
): PopulationDynamics {
  assertNonNegativeInt(population, "population");
  assertNonNegativeInt(housingQtyCentAbsorbed, "housingQtyCentAbsorbed");
  if (!Number.isFinite(elapsedSimSeconds) || elapsedSimSeconds < 0) {
    throw new Error(
      `applyPopulationDynamics: elapsedSimSeconds debe ser >= 0; recibido: ${elapsedSimSeconds}`,
    );
  }

  const decayable = Math.max(0, population - p.floor);
  const habitantsLost = Math.min(
    decayable,
    Math.floor(
      (population * p.decayBpsPerSimDay * elapsedSimSeconds) /
        (10_000 * SIM_SECONDS_PER_DAY),
    ),
  );
  // Solo las unidades ENTERAS de vivienda cuentan: media casa no aloja a nadie.
  // El resto se ha destruido igualmente (el lote ya se consumió), pero es un
  // efecto de borde inofensivo: los trades de vivienda son de unidades enteras.
  const habitantsGained =
    Math.floor(housingQtyCentAbsorbed / QTY_CENT_PER_UNIT) * p.habitantsPerHousing;

  return {
    populationAfter: population - habitantsLost + habitantsGained,
    habitantsGained,
    habitantsLost,
  };
}

/** Un producto de la cesta urbana con su referencia de valor. */
export interface BasketItem {
  productId: string;
  referenceCostCents: number;
}

export interface CityNeed {
  productId: string;
  /** Necesidad del periodo en centésimas de unidad. */
  qtyCent: number;
}

/**
 * Necesidad ACUMULADA de un producto desde el origen de la ciudad, en centésimas
 * de unidad, a partir de sus habitante-segundos consumidos.
 *
 *   cum_i(S) = floor(S × b × 100 / (n × coste_i × 3600))
 *
 * El presupuesto per cápita se reparte a partes iguales entre la cesta y cada
 * parte se convierte a unidades con el coste de referencia del producto: se
 * reparte en DINERO y no en unidades a propósito, porque con unidades iguales un
 * `automovil` (575.004 ¢) y un `pan` (190 ¢) generarían la misma demanda y el
 * gasto urbano se lo comerían los bienes caros, dejando la comida como ruido.
 */
function cumulativeNeedQtyCent(
  popSeconds: number,
  item: BasketItem,
  basketSize: number,
  budgetPerCapitaCentsPerSimHour: number,
): number {
  return Math.floor(
    (popSeconds * budgetPerCapitaCentsPerSimHour * QTY_CENT_PER_UNIT) /
      (basketSize * item.referenceCostCents * SIM_SECONDS_PER_HOUR),
  );
}

/**
 * Necesidad PURA de la cesta en el tramo de habitante-segundos [antes, después].
 *
 * Se calcula como DIFERENCIA de dos acumulados enteros y no como un `floor` del
 * tramo, y eso es lo importante: así el RESIDUO del redondeo se arrastra entre
 * pasadas en vez de truncarse a 0 en cada una. Con el truncamiento por pasada,
 * un producto solo se consumiría si su coste bajase de
 * `pob × b × Δt × 100 / (n × 3600)` — con los defaults, ~578 ¢ para una ciudad
 * de 1000 habitantes —, así que 40 de los 49 bienes finales tendrían demanda
 * urbana CERO para siempre y sus cadenas se quedarían sin salida (justo lo que
 * ADR-028 vino a cerrar). Acumulando, un bien caro se demanda "cada muchas
 * pasadas" en vez de nunca.
 *
 * El acumulador va en habitante-segundos y no en segundos para que un cambio de
 * población no provoque saltos: sus incrementos son exactamente población × Δt.
 *
 * Devuelve solo los productos con necesidad > 0, en el orden recibido.
 */
export function cityNeeds(
  popSecondsBefore: number,
  popSecondsAfter: number,
  basket: readonly BasketItem[],
  budgetPerCapitaCentsPerSimHour: number,
): CityNeed[] {
  assertNonNegativeInt(popSecondsBefore, "popSecondsBefore");
  assertNonNegativeInt(popSecondsAfter, "popSecondsAfter");
  if (popSecondsAfter <= popSecondsBefore || basket.length === 0) return [];

  const needs: CityNeed[] = [];
  for (const item of basket) {
    if (item.referenceCostCents <= 0) continue;
    const qtyCent =
      cumulativeNeedQtyCent(popSecondsAfter, item, basket.length, budgetPerCapitaCentsPerSimHour) -
      cumulativeNeedQtyCent(popSecondsBefore, item, basket.length, budgetPerCapitaCentsPerSimHour);
    if (qtyCent > 0) needs.push({ productId: item.productId, qtyCent });
  }
  return needs;
}

/**
 * Δt de una pasada en segundos SIMULADOS, acotado por arriba. Sin el techo, la
 * primera pasada tras una caída larga del worker arrasaría el inventario de
 * todas las ciudades y les aplicaría el decaimiento acumulado de golpe.
 *
 * `lastConsumptionAt` NULL (fila anterior a ADR-029) ⇒ 0: la pasada solo sirve
 * para sellar el instante y la siguiente ya mide un Δt real.
 */
export function elapsedSimSecondsFor(
  lastConsumptionAt: Date | null,
  now: Date,
  p: { simTimeFactor: number; maxCatchupSimSeconds: number },
): number {
  if (lastConsumptionAt === null) return 0;
  const realMs = now.getTime() - lastConsumptionAt.getTime();
  if (realMs <= 0) return 0;
  return Math.min(p.maxCatchupSimSeconds, (realMs * p.simTimeFactor) / 1000);
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} debe ser un entero seguro >= 0; recibido: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Pasada transaccional
// ---------------------------------------------------------------------------

export interface CityConsumptionResult {
  agentId: string;
  username: string;
  /** Δt simulado cubierto por la pasada. */
  elapsedSimSeconds: number;
  /** Habitante-segundos acumulados tras la pasada (el reloj del consumo). */
  consumedPopSecondsAfter: number;
  populationBefore: number;
  populationAfter: number;
  housingAbsorbedQtyCent: number;
  habitantsGained: number;
  habitantsLost: number;
  /** Consumo efectivo por producto (solo los > 0). */
  consumed: Array<{ productId: string; qtyCent: number }>;
  /** Necesidad no cubierta por producto (solo los > 0). */
  unmet: Array<{ productId: string; qtyCent: number }>;
}

/**
 * Ejecuta la pasada de consumo de UNA ciudad dentro de la tx del caller.
 * Devuelve `null` si la ciudad no existe, no está activa o su fila está
 * lockeada (se reintenta en la pasada siguiente, sin pérdida: el Δt se acumula).
 */
async function consumeForCity(
  tx: Tx,
  agentId: string,
  now: Date,
): Promise<CityConsumptionResult | null> {
  const city = await agentRepository.lockCityForConsumption(tx, agentId);
  if (city === null) return null;

  const cfg = config.cityConsumption;
  const elapsedSimSeconds = elapsedSimSecondsFor(city.lastConsumptionAt, now, {
    simTimeFactor: config.simTimeFactor,
    maxCatchupSimSeconds: cfg.maxCatchupSimSeconds,
  });

  // --- 1. Absorber vivienda -------------------------------------------------
  // Se absorbe TODA la que haya, con independencia del Δt: una casa comprada es
  // una casa habitada. Si la ciudad tiene vivienda reservada en una orden de
  // venta (no debería: las ciudades no venden), queda fuera por diseño de
  // `consumeAvailableFifoUpTo`.
  const housing = await catalogRepository.getHousingProduct(tx);
  let housingAbsorbedQtyCent = 0;
  if (housing !== undefined) {
    const absorbed = await inventoryService.consumeAvailableFifoUpTo(
      tx,
      agentId,
      housing.productId,
      TODO_EL_STOCK,
    );
    housingAbsorbedQtyCent = absorbed.reduce((s, a) => s + a.qtyCent, 0);
  }

  // --- 2. Población ---------------------------------------------------------
  const dynamics = applyPopulationDynamics(
    city.population,
    housingAbsorbedQtyCent,
    elapsedSimSeconds,
    {
      habitantsPerHousing: cfg.habitantsPerHousing,
      decayBpsPerSimDay: cfg.populationDecayBpsPerSimDay,
      floor: cfg.initialPopulation,
    },
  );
  // El reloj del consumo avanza en habitante-segundos con la población YA
  // actualizada: la casa comprada empieza a consumir en esta misma pasada.
  const popSecondsBefore = city.consumedPopSeconds ?? 0;
  const popSecondsAfter =
    popSecondsBefore + Math.floor(dynamics.populationAfter * elapsedSimSeconds);
  await agentRepository.updateCityPopulation(tx, agentId, {
    population: dynamics.populationAfter,
    lastConsumptionAt: now,
    consumedPopSeconds: popSecondsAfter,
  });

  // --- 3 y 4. Necesidad de la cesta y consumo destructivo -------------------
  const basket = await catalogRepository.listUrbanBasket(tx);
  const needs = cityNeeds(
    popSecondsBefore,
    popSecondsAfter,
    basket,
    cfg.needBudgetPerCapitaCentsPerSimHour,
  );

  const consumed: Array<{ productId: string; qtyCent: number }> = [];
  const unmet: Array<{ productId: string; qtyCent: number }> = [];
  for (const need of needs) {
    const allocations = await inventoryService.consumeAvailableFifoUpTo(
      tx,
      agentId,
      need.productId,
      need.qtyCent,
    );
    const got = allocations.reduce((s, a) => s + a.qtyCent, 0);
    if (got > 0) consumed.push({ productId: need.productId, qtyCent: got });
    if (got < need.qtyCent) {
      unmet.push({ productId: need.productId, qtyCent: need.qtyCent - got });
    }
  }

  // --- Eventos (dentro de la tx, antes del commit) --------------------------
  const consumedQtyCent = consumed.reduce((s, c) => s + c.qtyCent, 0);
  const unmetQtyCent = unmet.reduce((s, c) => s + c.qtyCent, 0);
  if (consumedQtyCent > 0 || unmetQtyCent > 0) {
    await appendEvent(tx, {
      type: "city_consumed",
      agentId,
      payload: {
        agent_id: agentId,
        elapsed_sim_seconds: Math.round(elapsedSimSeconds),
        consumed_qty_cent: consumedQtyCent,
        unmet_qty_cent: unmetQtyCent,
        products_consumed: consumed.length,
      },
    });
  }
  if (dynamics.populationAfter !== city.population) {
    await appendEvent(tx, {
      type: "city_population_changed",
      agentId,
      payload: {
        agent_id: agentId,
        population_before: city.population,
        population_after: dynamics.populationAfter,
        housing_absorbed_qty_cent: housingAbsorbedQtyCent,
        habitants_gained: dynamics.habitantsGained,
        habitants_lost: dynamics.habitantsLost,
      },
    });
  }

  return {
    agentId,
    username: city.username,
    elapsedSimSeconds,
    consumedPopSecondsAfter: popSecondsAfter,
    populationBefore: city.population,
    populationAfter: dynamics.populationAfter,
    housingAbsorbedQtyCent,
    habitantsGained: dynamics.habitantsGained,
    habitantsLost: dynamics.habitantsLost,
    consumed,
    unmet,
  };
}

/**
 * Ids de las ciudades activas de la pasada, en orden determinista. Lo lee el
 * sweeper en una tx aparte (solo lectura) antes de procesarlas una a una.
 */
async function listCityIds(tx: Tx): Promise<string[]> {
  return agentRepository.listActiveCityIds(tx);
}

/**
 * Necesidad ACTUAL de una ciudad para exponerla por API (`GET
 * /agents/me/city-needs`): el mismo cálculo que aplica el sweeper, normalizado a
 * un periodo de referencia (el intervalo del sweeper), más el stock que la
 * ciudad ya tiene. Es lo que permite al bot comprar lo que le falta sin
 * replicar la fórmula ni conocer las perillas del servidor.
 */
async function getCityNeeds(
  tx: Tx,
  agentId: string,
  population: number,
  consumedPopSeconds: number,
): Promise<{
  periodSimSeconds: number;
  needs: Array<{
    productId: string;
    productKey: string;
    qtyCentPerPeriod: number;
    qtyAvailableCent: number;
  }>;
}> {
  const periodSimSeconds =
    (config.sweeps.cityConsumptionIntervalMs * config.simTimeFactor) / 1000;
  const basket = await catalogRepository.listUrbanBasket(tx);
  // Se proyecta UN periodo hacia delante desde el reloj real de la ciudad, no
  // desde cero: así la cifra incluye el residuo ya acumulado y coincide
  // exactamente con lo que el sweeper consumirá en la próxima pasada.
  const needs = cityNeeds(
    consumedPopSeconds,
    consumedPopSeconds + Math.floor(population * periodSimSeconds),
    basket,
    config.cityConsumption.needBudgetPerCapitaCentsPerSimHour,
  );
  const needByProduct = new Map(needs.map((n) => [n.productId, n.qtyCent]));
  const positions = await inventoryService.getPositions(tx, agentId);
  const availableByProduct = new Map(positions.map((p) => [p.productId, p.qtyAvailable]));

  return {
    periodSimSeconds,
    // Se devuelve la cesta COMPLETA, incluidos los productos con necesidad 0
    // (población pequeña + producto caro): el cliente necesita saber que existen
    // para no inferir que están fuera de la cesta.
    needs: basket.map((item) => ({
      productId: item.productId,
      productKey: item.key,
      qtyCentPerPeriod: needByProduct.get(item.productId) ?? 0,
      qtyAvailableCent: availableByProduct.get(item.productId) ?? 0,
    })),
  };
}

export const cityConsumptionService = {
  consumeForCity,
  listCityIds,
  getCityNeeds,
};
