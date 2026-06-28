// The persistence boundary the tick worker runs against (docs/PHASE2.md §5). The
// store holds the world the way Postgres will — a world snapshot, the season's
// resolved fixtures, and a tick-log that makes resolution idempotent. The tick
// logic (tick.ts) is written against this interface, so swapping `MemoryStore`
// for a `PgStore` later is mechanical and changes no resolution code.
import type { WorldState, MatchResult } from '@ace/world';
import type { MatchInput } from '@ace/shared';

export type TickKind = 'matchday' | 'rollover';

/** A persisted fixture row (mirrors the `fixture` table — score is canonical
 *  truth; the full timeline is a re-sim derivation, not stored). `inputSnapshot`
 *  is present only for WATCHABLE fixtures (§7) so the client can re-sim to watch;
 *  dormant all-AI fixtures store just the score. */
export interface FixtureRow {
  worldId: string; season: number; day: number; slot: number;
  home: number; away: number; seed: number;
  homeScore: number; awayScore: number; winner: number;
  inputSnapshot?: MatchInput;
  // broadcast window (live.ts): the result is sealed until kickoffAt + broadcastSecs
  kickoffAt?: number; broadcastSecs?: number;
}

/** A tick-log row (the idempotency key — `unique(worldId, season, day, kind)`). */
export interface TickRow { worldId: string; season: number; day: number; kind: TickKind; fixtures: number }

/** The persistence boundary — **async** so a real (Postgres) store fits behind the
 *  same interface (the `MemoryStore` just resolves immediately). The tick worker +
 *  HTTP layer await every call, so swapping `MemoryStore` for `PgStore` changes no
 *  resolution code. */
export interface WorldStore {
  /** Persist a freshly generated world; returns its id. */
  createWorld(w: WorldState): Promise<string>;
  loadWorld(id: string): Promise<WorldState | null>;
  saveWorld(id: string, w: WorldState): Promise<void>;
  listWorlds(): Promise<string[]>;
  /** Append a resolved match-day's fixtures (the canonical record). */
  appendFixtures(id: string, rows: FixtureRow[]): Promise<void>;
  fixtures(id: string, season?: number): Promise<FixtureRow[]>;
  /** Idempotency: has this (season, day, kind) tick already been recorded? */
  tickDone(id: string, season: number, day: number, kind: TickKind): Promise<boolean>;
  recordTick(row: TickRow): Promise<void>;
  ticks(id: string): Promise<TickRow[]>;
  // ── per-account durable state (the academy pipeline, scout reports, inboxes) ──
  // A human's PRIVATE per-world state, keyed by (worldId, accountId) — kept out of the
  // shared `WorldState` snapshot so it doesn't bloat the world or leak between owners.
  // Stored as one jsonb blob per (world, account); the server owns the shape.
  loadAccountData(id: string, account: string): Promise<Record<string, unknown> | null>;
  saveAccountData(id: string, account: string, data: Record<string, unknown>): Promise<void>;
  /** Every owner's account-data for a world (so the tick can develop all academies). */
  listAccountData(id: string): Promise<{ account: string; data: Record<string, unknown> }[]>;
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

  async createWorld(w: WorldState): Promise<string> {
    const id = `world-${++this.n}`;
    this.worlds.set(id, structuredClone(w));
    this.fixtureRows.set(id, []);
    this.tickRows.set(id, []);
    return id;
  }
  async loadWorld(id: string): Promise<WorldState | null> {
    const w = this.worlds.get(id);
    return w ? structuredClone(w) : null;   // copy out, like a row read — callers can't mutate our state
  }
  async saveWorld(id: string, w: WorldState): Promise<void> {
    if (!this.worlds.has(id)) throw new Error(`saveWorld: unknown world ${id}`);
    this.worlds.set(id, structuredClone(w));
  }
  async listWorlds(): Promise<string[]> { return [...this.worlds.keys()]; }

  async appendFixtures(id: string, rows: FixtureRow[]): Promise<void> { this.fixtureRows.get(id)!.push(...rows); }
  async fixtures(id: string, season?: number): Promise<FixtureRow[]> {
    const all = this.fixtureRows.get(id) ?? [];
    return season == null ? all : all.filter(r => r.season === season);
  }

  async tickDone(id: string, season: number, day: number, kind: TickKind): Promise<boolean> {
    return (this.tickRows.get(id) ?? []).some(t => t.season === season && t.day === day && t.kind === kind);
  }
  async recordTick(row: TickRow): Promise<void> {
    if ((this.tickRows.get(row.worldId) ?? []).some(t => t.season === row.season && t.day === row.day && t.kind === row.kind)) throw new Error(`recordTick: duplicate ${row.season}/${row.day}/${row.kind}`);
    this.tickRows.get(row.worldId)!.push(row);
  }
  async ticks(id: string): Promise<TickRow[]> { return [...(this.tickRows.get(id) ?? [])]; }

  private accountData = new Map<string, Record<string, unknown>>();   // `${id}:${account}` → blob
  async loadAccountData(id: string, account: string): Promise<Record<string, unknown> | null> {
    const d = this.accountData.get(`${id}:${account}`);
    return d ? structuredClone(d) : null;   // copy out, like a row read
  }
  async saveAccountData(id: string, account: string, data: Record<string, unknown>): Promise<void> {
    this.accountData.set(`${id}:${account}`, structuredClone(data));
  }
  async listAccountData(id: string): Promise<{ account: string; data: Record<string, unknown> }[]> {
    const out: { account: string; data: Record<string, unknown> }[] = [];
    for (const [k, data] of this.accountData) { const [wid, account] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]; if (wid === id) out.push({ account, data: structuredClone(data) }); }
    return out;
  }
}
