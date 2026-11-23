/** The same seed reproduces the same demo data. */

export interface Random {
  /** A number from 0 (included) to 1 (excluded). */
  next(): number;
  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  /** One of the items, each equally likely. */
  pick<T>(items: readonly T[]): T;
  /** One of the items, by weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  normal(mean: number, deviation: number): number;
  /** A log-normally distributed number with this median: durations and Web Vitals. */
  logNormal(median: number, spread: number): number;
  /** A UUID (version 4 in form), from the seed. */
  uuid(): string;
  /** `bytes` random bytes in hex: a trace ID is 16, a span ID 8. */
  hex(bytes: number): string;
}

/** mulberry32 uses a 32-bit state for repeatable fake data. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const hex = (bytes: number) => {
    let text = "";
    for (let index = 0; index < bytes; index += 1) {
      text += Math.floor(next() * 256)
        .toString(16)
        .padStart(2, "0");
    }
    return text;
  };
  const random: Random = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("Cannot pick from an empty list");
      return item;
    },
    weighted: (items) => {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0);
      let left = next() * total;
      for (const [item, weight] of items) {
        left -= weight;
        if (left < 0) return item;
      }
      const last = items.at(-1);
      if (last === undefined) throw new Error("Cannot pick from an empty list");
      return last[0];
    },
    normal: (mean, deviation) => {
      // Box-Muller; 1 - next() is never 0.
      const u = 1 - next();
      const v = next();
      return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    logNormal: (median, spread) => median * Math.exp(random.normal(0, spread)),
    uuid: () => {
      const text = hex(16);
      const variant = ((Number.parseInt(text.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-${variant}${text.slice(17, 20)}-${text.slice(20, 32)}`;
    },
    hex,
  };
  return random;
}
