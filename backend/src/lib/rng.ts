/**
 * RNG determinista para el seed y utilidades reproducibles (contrato §13).
 *
 * Generador: mulberry32 (32 bits, rápido y suficiente para la simulación).
 * Derivación de semillas: hash FNV-1a del `key` mezclado con la semilla
 * maestra + finalizador de avalancha (splitmix32) para dispersar bits.
 */

/** Generador determinista: devuelve un float uniforme en [0, 1). */
export type Rng = () => number;

/** Hash FNV-1a de 32 bits de un string. */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deriva una semilla de 32 bits determinista a partir de la semilla maestra
 * y una clave textual (p. ej. el username del agente).
 */
export function seedFrom(masterSeed: number, key: string): number {
  let h = (fnv1a32(key) ^ (masterSeed >>> 0)) >>> 0;
  // Finalizador de avalancha (constantes de splitmix32).
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

/** mulberry32: PRNG determinista de 32 bits de estado. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Conveniencia: RNG determinista para `(masterSeed, key)`. */
export function rngFor(masterSeed: number, key: string): Rng {
  return mulberry32(seedFrom(masterSeed, key));
}

/** Entero uniforme en [min, max], AMBOS extremos incluidos. */
export function randIntInclusive(rng: Rng, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new Error(`randIntInclusive: min/max deben ser enteros; recibido: ${min}, ${max}`);
  }
  if (min > max) {
    throw new Error(`randIntInclusive: min (${min}) > max (${max})`);
  }
  return min + Math.floor(rng() * (max - min + 1));
}
