// A typed client for the @ace/server live-broadcast API (apps/server/src/http.ts).
// This is the seam that turns the single-player client into the async-PvP client:
// the world resolves on the SERVER tick, and the browser watches it — live with the
// result embargo, then by re-simming the snapshot once revealed (the engine runs
// client-side, so watching still costs the server ~nothing). Read-only here; the
// ownership write-path (claim/plan) rides the same base.
import type { MatchInput, MapId, Tactics } from '@ace/shared';

export interface WorldSummary { id: string; region: string; season: number; day: number; tiers: number; layout: number[]; divisions: number; clubs: number; broadcastDay: number; lastDay: number; kickoffAt: number; revealAt: number; now: number }
export interface StandingRow { club: string; played: number; won: number; lost: number; diff: number; points: number }
export interface ClubLabel { tag: string; name: string }
export interface LiveFixture {
  slot: number; status: 'scheduled' | 'live' | 'resolved';
  frac: number; running: [number, number]; round: number; rounds: number;
  final: [number, number] | null; home: ClubLabel; away: ClubLabel; map: MapId | null;
}
export interface ReplayPayload { seed: number; snapshot: MatchInput | null; score: [number, number] }
export interface FixturePublic { status: 'scheduled' | 'live' | 'resolved'; frac: number; score?: [number, number]; home: ClubLabel; away: ClubLabel; map: MapId | null }
export interface Session { accountId: string; accessToken: string; refreshToken: string }
export interface AttrScout { key: string; cur: number; ceil: number; mech: boolean }
export interface MarketEntry { handle: string; role: string; age: number; overall: number; value: number; contested: boolean; ceiling: [number, number]; scoutLevel: number; attrs: AttrScout[] }
export interface ScoutResult { ok: boolean; reason?: string; level: number; cost?: number; nextCost?: number | null; ceiling: [number, number]; balance?: number }
export interface BidResult { ok: boolean; reason?: string; leader?: string; leadBid?: number; paid?: number; club?: ClubPage }
export interface SquadPlayer { id: string; handle: string; role: string; age: number; overall: number; value: number; starter: boolean; ceiling: [number, number]; room: number; attrs: AttrScout[] }
export interface SaleResult { ok: boolean; reason?: string; fee?: number; buyer?: string; club?: ClubPage }
export interface FivePlayer { handle: string; role: string; overall: number; igl: boolean; solo?: string; soloTier?: string }
export interface ClubPlan { tactics: Tactics; comp?: Record<string, string>; lineup?: string[] }
export interface Prospect { id: string; handle: string; role: string; age: number; overall: number; ceiling: [number, number]; room: number; scoutLevel: number; attrs: AttrScout[] }
export interface AcademyView { level: number; max: number; cost: number | null; canUpgrade: boolean; upkeep: number; intakeNext: number; wageBill: number; prospects: Prospect[] }
export interface ClubPage { tag: string; name: string; tier: number; group: number; titles: number; owned: boolean; rating: number; phase?: string; five: FivePlayer[]; plan?: ClubPlan; balance?: number; squad?: SquadPlayer[]; academy?: AcademyView }

export interface LeaderRow { rank: number; handle: string; role: string; age: number; overall: number; soloLabel: string; soloTier: string; club: string; clubTag: string; tier: number; owned: boolean }
export interface ClubRankRow { rank: number; tag: string; name: string; tier: number; group: number; power: number; phase: string; infra: number; titles: number; owned: boolean }
export interface NewsItem { kind: 'transfer' | 'champion' | 'season' | 'award'; text: string; season: number; day: number }
export interface StatRow { rank: number; handle: string; club: string; role: string; kills: number; deaths: number; matches: number; fb: number; mvp: number; kd: number }

export interface IntlSide { region: string; tag: string }
export interface CircuitView {
  seed: number;
  regions: { region: string; champion: string; top: string[] }[];
  bracket: {
    field: IntlSide[];
    rounds: { round: number; a: IntlSide; b: IntlSide; winner: IntlSide }[][];
    champion: { region: string; tag: string; name: string };
  };
  final: { a: IntlSide; b: IntlSide; map: MapId; score: [number, number]; seed: number; snapshot: MatchInput; prize: number };
}

const j = async <T>(r: Response): Promise<T> => {
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* non-json */ } throw new Error(m); }
  return r.json() as Promise<T>;
};

/** A handle to one live server. `base` is its origin (e.g. http://127.0.0.1:8787). */
export class AceServer {
  constructor(public base: string) { this.base = base.replace(/\/$/, ''); }

  world(): Promise<WorldSummary> { return fetch(`${this.base}/world`).then(r => j<WorldSummary>(r)); }
  circuit(): Promise<CircuitView> { return fetch(`${this.base}/circuit`).then(r => j<CircuitView>(r)); }
  /** The Hall of Fame — season champions + all-time title leaders (the legacy engine). */
  honors(): Promise<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[] }> {
    return fetch(`${this.base}/honors`).then(r => j<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[] }>(r));
  }
  /** A club's public page (identity, division, the fielded five) — read-only. */
  club(slug: string): Promise<ClubPage> { return fetch(`${this.base}/clubs/${slug}`).then(r => j<ClubPage>(r)); }
  /** The world's best players (cross-club prestige board), optionally by role. */
  leaderboard(role?: string): Promise<{ players: LeaderRow[] }> {
    return fetch(`${this.base}/leaderboard${role ? `?role=${role}` : ''}`).then(r => j<{ players: LeaderRow[] }>(r));
  }
  /** The world's strongest clubs by squad power (+ lifecycle stage + infra). */
  powerRankings(): Promise<{ clubs: ClubRankRow[] }> { return fetch(`${this.base}/powerrankings`).then(r => j<{ clubs: ClubRankRow[] }>(r)); }
  /** The world news feed — recent transfers + champions (newest first). */
  news(): Promise<{ news: NewsItem[] }> { return fetch(`${this.base}/news`).then(r => j<{ news: NewsItem[] }>(r)); }
  /** Season player stats (top fraggers) from resolved watched matches. */
  stats(): Promise<{ season: number; players: StatRow[] }> { return fetch(`${this.base}/stats`).then(r => j<{ season: number; players: StatRow[] }>(r)); }
  standings(season: number, tier: number, group = 0): Promise<{ tier: number; group: number; table: StandingRow[] }> {
    return fetch(`${this.base}/standings/${season}/${tier}/${group}`).then(r => j<{ tier: number; group: number; table: StandingRow[] }>(r));
  }
  /** A fixture's spoiler-safe public view (who's playing, status, final once resolved). */
  fixture(season: number, day: number, slot: number): Promise<FixturePublic> {
    return fetch(`${this.base}/fixtures/${season}/${day}/${slot}`).then(r => j<FixturePublic>(r));
  }
  /** A watchable fixture's snapshot once resolved — 425 until then (returns null). */
  async replay(season: number, day: number, slot: number): Promise<ReplayPayload | null> {
    const r = await fetch(`${this.base}/fixtures/${season}/${day}/${slot}/replay`);
    return r.status === 425 ? null : await j<ReplayPayload>(r);
  }

  // ── identity + ownership (self-owned auth → claim a club → author its plan) ──
  private post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return fetch(`${this.base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(r => j<T>(r));
  }
  register(email: string, password: string): Promise<Session> { return this.post('/auth/register', { email, password }); }
  login(email: string, password: string): Promise<Session> { return this.post('/auth/login', { email, password }); }
  /** Claim an AI club (by tag or id) for the bearer's account. */
  claim(clubTag: string, token: string): Promise<ClubPage> { return this.post(`/clubs/${clubTag}/claim`, {}, token); }
  /** The club this account owns (null if none). */
  async me(token: string): Promise<ClubPage | null> {
    const r = await fetch(`${this.base}/me`, { headers: { authorization: `Bearer ${token}` } });
    return r.ok ? (r.json() as Promise<ClubPage | null>) : null;
  }
  /** The free-agent board (value + contested flag). */
  market(): Promise<{ board: MarketEntry[] }> { return fetch(`${this.base}/market`).then(r => j<{ board: MarketEntry[] }>(r)); }
  /** Bid on a free agent — signs if you clear the asking price AND beat the rival
   *  ceiling; otherwise returns the leader + their bid so you can raise or walk. */
  bid(handle: string, amount: number, token: string): Promise<BidResult> { return this.post('/market/bid', { handle, amount }, token); }
  /** Sell a rostered player to the richest willing AI club (market fee). */
  sell(ref: string, token: string): Promise<SaleResult> { return this.post('/market/sell', { ref }, token); }
  /** Commission a paid scouting report on a board free agent — charges your club and
   *  tightens the ceiling band for your eyes (private knowledge, the price stays fogged). */
  scout(handle: string, token: string): Promise<ScoutResult> { return this.post('/market/scout', { handle }, token); }

  // ── the academy (the homegrown youth pipeline) ──
  /** Build/expand the youth wing — charges your club; a fresh academy delivers its
   *  first intake of teenage prospects immediately. Returns the updated academy view. */
  upgradeAcademy(token: string): Promise<AcademyView & { error?: string }> { return this.post('/academy/upgrade', {}, token); }
  /** Graduate a prospect into your senior roster — no transfer fee. */
  promoteProspect(ref: string, token: string): Promise<{ ok: boolean; error?: string; academy?: AcademyView; squad?: SquadPlayer[] }> { return this.post('/academy/promote', { ref }, token); }
  /** Cut a prospect you've given up on. */
  cutProspect(ref: string, token: string): Promise<AcademyView> { return this.post('/academy/cut', { ref }, token); }
  /** Commission a scouting report on one of your prospects (owned → a tighter read). */
  scoutProspect(ref: string, token: string): Promise<ScoutResult> { return this.post('/academy/scout', { ref }, token); }
  /** Advance the season a match-day (owner action — the scheduler does this in prod).
   *  At the season boundary it rolls over: `rollover` + the new `season` + `champion`. */
  advance(token: string): Promise<{ broadcastDay: number; done: boolean; rollover?: boolean; season?: number; champion?: string; rivalSignings?: number }> { return this.post('/advance', {}, token); }

  /** Author your club's plan — the tactics that drive your matches on the next tick. */
  setPlan(tactics: Tactics, token: string): Promise<ClubPlan> {
    return fetch(`${this.base}/me/plan`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ tactics }),
    }).then(r => j<ClubPlan>(r));
  }
  /** Set your fielded five — an explicit lineup (2 duelists + 1 init/ctrl/sentinel)
   *  drives who plays AND who develops (a started prospect gets reps; a benched one
   *  rusts). Rejected if it isn't a valid five. */
  setLineup(lineup: string[], token: string): Promise<ClubPlan> {
    return fetch(`${this.base}/me/plan`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ lineup }),
    }).then(r => j<ClubPlan>(r));
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
