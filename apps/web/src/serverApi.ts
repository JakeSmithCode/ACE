// A typed client for the @ace/server live-broadcast API (apps/server/src/http.ts).
// This is the seam that turns the single-player client into the async-PvP client:
// the world resolves on the SERVER tick, and the browser watches it — live with the
// result embargo, then by re-simming the snapshot once revealed (the engine runs
// client-side, so watching still costs the server ~nothing). Read-only here; the
// ownership write-path (claim/plan) rides the same base.
import type { MatchInput, MapId } from '@ace/shared';

export interface WorldSummary { id: string; region: string; season: number; day: number; tiers: number; layout: number[]; divisions: number; clubs: number }
export interface StandingRow { club: string; played: number; won: number; lost: number; diff: number; points: number }
export interface ClubLabel { tag: string; name: string }
export interface LiveFixture {
  slot: number; status: 'scheduled' | 'live' | 'resolved';
  frac: number; running: [number, number]; round: number; rounds: number;
  final: [number, number] | null; home: ClubLabel; away: ClubLabel; map: MapId | null;
}
export interface ReplayPayload { seed: number; snapshot: MatchInput | null; score: [number, number] }

const j = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json() as Promise<T>; };

/** A handle to one live server. `base` is its origin (e.g. http://127.0.0.1:8787). */
export class AceServer {
  constructor(public base: string) { this.base = base.replace(/\/$/, ''); }

  world(): Promise<WorldSummary> { return fetch(`${this.base}/world`).then(r => j<WorldSummary>(r)); }
  standings(season: number, tier: number, group = 0): Promise<{ tier: number; group: number; table: StandingRow[] }> {
    return fetch(`${this.base}/standings/${season}/${tier}/${group}`).then(r => j<{ tier: number; group: number; table: StandingRow[] }>(r));
  }
  /** A watchable fixture's snapshot once resolved — 425 until then (returns null). */
  async replay(season: number, day: number, slot: number): Promise<ReplayPayload | null> {
    const r = await fetch(`${this.base}/fixtures/${season}/${day}/${slot}/replay`);
    return r.status === 425 ? null : await j<ReplayPayload>(r);
  }

  /** Subscribe to a day's synced live match-center (SSE). `onFrame` fires ~1/s with
   *  every watched fixture's running score; returns an unsubscribe fn. Falls back to
   *  polling is unnecessary — EventSource handles reconnect. */
  liveStream(season: number, day: number, onFrame: (fixtures: LiveFixture[]) => void, onDone?: () => void): () => void {
    const es = new EventSource(`${this.base}/live/${season}/${day}`);
    es.onmessage = e => { try { onFrame((JSON.parse(e.data).fixtures ?? []) as LiveFixture[]); } catch { /* keepalive */ } };
    es.addEventListener('done', () => { es.close(); onDone?.(); });
    return () => es.close();
  }
}
