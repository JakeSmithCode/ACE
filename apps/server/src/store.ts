// The persistence boundary the tick worker runs against (docs/PHASE2.md §5). The
// store holds the world the way Postgres will — a world snapshot, the season's
// resolved fixtures, and a tick-log that makes resolution idempotent. The tick
// logic (tick.ts) is written against this interface, so swapping `MemoryStore`
// for a `PgStore` later is mechanical and changes no resolution code.
import type { WorldState } from '@ace/world';
import type { MatchResult } from '@ace/world';

export type TickKind = 'matchday' | 'rollover';

/** A persisted fixture row (mirrors the `fixture` table — score is canonical
 *  truth; the full timeline is a re-sim derivation, not stored here). */
export interface FixtureRow {
  worldId: string; season: number; day: number; slot: number;
  home: number; away: number; seed: number;
  homeScore: number; awayScore: number; winner: number;
}

/** A tick-log row (the idempotency key — `unique(worldId, season, day, kind)`). */
export interface TickRow { worldId: string; season: number; day: number; kind: TickKind; fixtures: number }

export interface WorldStore {
  /** Persist a freshly generated world; returns its id. */
  createWorld(w: WorldState): string;
  loadWorld(id: string): WorldState | null;
  saveWorld(id: string, w: WorldState): void;
  listWorlds(): string[];
  /** Append a resolved match-day's fixtures (the canonical record). */
  appendFixtures(id: string, rows: FixtureRow[]): void;
  fixtures(id: string, season?: number): FixtureRow[];
  /** Idempotency: has this (season, day, kind) tick already been recorded? */
  tickDone(id: string, season: number, day: number, kind: TickKind): boolean;
  recordTick(row: TickRow): void;
  ticks(id: string): TickRow[];
}

/** A fixture row built from a resolved `MatchResult` (club indices are the world's
 *  stable club identities here; the Pg store would map them to club UUIDs). */
export function fixtureRow(worldId: string, season: number, day: number, slot: number, r: MatchResult): FixtureRow {
  return {
    worldId, season, day, slot,
    home: r.home, away: r.away, seed: r.seed,
    homeScore: r.score[0], awayScore: r.score[1], winner: r.winner,
  };
}

/** In-memory implementation — proves the boundary and runs the whole tick loop
 *  headless. Deterministic (no clock / random): world ids are a simple counter. */
export class MemoryStore implements WorldStore {
  private worlds = new Map<string, WorldState>();
  private fixtureRows = new Map<string, FixtureRow[]>();
  private tickRows = new Map<string, TickRow[]>();
  private n = 0;

  createWorld(w: WorldState): string {
    const id = `world-${++this.n}`;
    this.worlds.set(id, structuredClone(w));
    this.fixtureRows.set(id, []);
    this.tickRows.set(id, []);
    return id;
  }
  loadWorld(id: string): WorldState | null {
    const w = this.worlds.get(id);
    return w ? structuredClone(w) : null;   // copy out, like a row read — callers can't mutate our state
  }
  saveWorld(id: string, w: WorldState): void {
    if (!this.worlds.has(id)) throw new Error(`saveWorld: unknown world ${id}`);
    this.worlds.set(id, structuredClone(w));
  }
  listWorlds(): string[] { return [...this.worlds.keys()]; }

  appendFixtures(id: string, rows: FixtureRow[]): void { this.fixtureRows.get(id)!.push(...rows); }
  fixtures(id: string, season?: number): FixtureRow[] {
    const all = this.fixtureRows.get(id) ?? [];
    return season == null ? all : all.filter(r => r.season === season);
  }

  tickDone(id: string, season: number, day: number, kind: TickKind): boolean {
    return (this.tickRows.get(id) ?? []).some(t => t.season === season && t.day === day && t.kind === kind);
  }
  recordTick(row: TickRow): void {
    if (this.tickDone(row.worldId, row.season, row.day, row.kind)) throw new Error(`recordTick: duplicate ${row.season}/${row.day}/${row.kind}`);
    this.tickRows.get(row.worldId)!.push(row);
  }
  ticks(id: string): TickRow[] { return [...(this.tickRows.get(id) ?? [])]; }
}
