/** Deterministic PRNG (mulberry32). No Math.random anywhere in the engine. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s |= 0; this.s = (this.s + 0x6D2B79F5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
}
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
