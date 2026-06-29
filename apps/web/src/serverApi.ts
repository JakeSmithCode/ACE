// A typed client for the @ace/server live-broadcast API (apps/server/src/http.ts).
// This is the seam that turns the single-player client into the async-PvP client:
// the world resolves on the SERVER tick, and the browser watches it — live with the
// result embargo, then by re-simming the snapshot once revealed (the engine runs
// client-side, so watching still costs the server ~nothing). Read-only here; the
// ownership write-path (claim/plan) rides the same base.
import type { MatchInput, MapId, Tactics, MatchTimeline } from '@ace/shared';

export interface WorldSummary { id: string; region: string; season: number; day: number; tiers: number; layout: number[]; divisions: number; clubs: number; broadcastDay: number; lastDay: number; kickoffAt: number; revealAt: number; now: number }
export interface StandingRow { club: string; played: number; won: number; lost: number; diff: number; points: number }
export interface ClubLabel { tag: string; name: string }
export interface LiveFixture {
  slot: number; status: 'scheduled' | 'live' | 'resolved';
  frac: number; running: [number, number]; round: number; rounds: number;
  final: [number, number] | null; home: ClubLabel; away: ClubLabel; map: MapId | null;
}
export interface ReplayPayload { seed: number; snapshot: MatchInput | null; score: [number, number] }
export interface LiveTimeline { status: 'scheduled' | 'live' | 'resolved'; frac: number; completed: number; total: number; resolved: boolean; timeline: MatchTimeline | null }
export interface FixturePublic { status: 'scheduled' | 'live' | 'resolved'; frac: number; score?: [number, number]; home: ClubLabel; away: ClubLabel; map: MapId | null }
export interface Session { accountId: string; accessToken: string; refreshToken: string }
/** Register also returns the email-verification token. In production it's emailed (a
 *  link the user clicks); this dev/demo surface returns it so the client can complete
 *  verification inline — a real account must be verified before it can claim a club. */
export interface RegisterResult extends Session { verifyToken: string }
export interface AttrScout { key: string; cur: number; ceil: number; mech: boolean }
export interface MarketEntry { handle: string; role: string; age: number; overall: number; value: number; contested: boolean; ceiling: [number, number]; scoutLevel: number; attrs: AttrScout[] }
export interface ScoutResult { ok: boolean; reason?: string; level: number; cost?: number; nextCost?: number | null; ceiling: [number, number]; balance?: number }
export interface BidResult { ok: boolean; reason?: string; leader?: string; leadBid?: number; paid?: number; club?: ClubPage }
export interface SquadPlayer { id: string; handle: string; role: string; age: number; overall: number; value: number; starter: boolean; ceiling: [number, number]; room: number; attrs: AttrScout[] }
export interface SaleResult { ok: boolean; reason?: string; fee?: number; buyer?: string; club?: ClubPage }
export interface FivePlayer { handle: string; role: string; overall: number; igl: boolean; solo?: string; soloTier?: string; agent?: string; trait?: string | null; name?: string; country?: string; flag?: string; age?: number }
export interface ClubPlan { tactics: Tactics; comp?: Record<string, string>; lineup?: string[] }
export interface Prospect { id: string; handle: string; role: string; age: number; overall: number; ceiling: [number, number]; room: number; scoutLevel: number; attrs: AttrScout[] }
export interface AcademyView { level: number; max: number; cost: number | null; canUpgrade: boolean; upkeep: number; intakeNext: number; wageBill: number; prospects: Prospect[] }
export interface Dossier { attack: string; defense: string; lurk: boolean; counter: string }
export interface ClubPage { tag: string; name: string; tier: number; group: number; titles: number; intlTitles?: number; owned: boolean; rating: number; phase?: string; style?: { archetype: string; label: string } | null; dossier?: Dossier | null; five: FivePlayer[]; plan?: ClubPlan; balance?: number; squad?: SquadPlayer[]; academy?: AcademyView }

export interface LeaderRow { rank: number; handle: string; name?: string; flag?: string; role: string; age: number; overall: number; soloLabel: string; soloTier: string; club: string; clubTag: string; tier: number; owned: boolean }
export interface ClubRankRow { rank: number; tag: string; name: string; tier: number; group: number; power: number; phase: string; infra: number; titles: number; owned: boolean }
export interface NewsItem { kind: 'transfer' | 'champion' | 'season' | 'award'; text: string; season: number; day: number }
export interface StatRow { rank: number; handle: string; club: string; role: string; kills: number; deaths: number; matches: number; fb: number; mvp: number; kd: number }
export interface Notif { id: number; kind: 'fixture' | 'result' | 'season' | 'award' | 'system'; text: string; season: number; day: number; read: boolean; at: number }
export interface MailMsg { id: number; threadId: number; fromTag: string; fromName: string; toTag: string; subject: string; body: string; season: number; day: number; read: boolean; mine: boolean; at: number }
export interface ChatMsg { id: number; room: string; fromTag: string; fromName: string; text: string; at: number }

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

export interface WCSide { code: string; country: string; flag: string }
export interface WCPlayer { handle: string; name: string; role: string; overall: number; igl: boolean; agent: string; solo: string; soloTier: string }
export interface WorldCupView {
  season: number;
  squads: { code: string; country: string; flag: string; strength: number; pool: number; manager: string | null; five: WCPlayer[] }[];
  bracket: { field: WCSide[]; rounds: { round: number; a: WCSide; b: WCSide; winner: WCSide }[][]; champion: WCSide };
  final: { a: WCSide; b: WCSide; map: MapId; score: [number, number]; seed: number; snapshot: MatchInput };
}
export interface NationElection {
  code: string; country: string; flag: string;
  manager: string | null;                                   // the elected manager's club tag
  candidates: { tag: string; votes: number; you: boolean }[];
  hasTactics: boolean; youCandidate: boolean; youManager: boolean;
  yourVoteTag: string | null;                               // who you backed
  tactics?: Tactics;                                        // present only if you're the manager
}
export interface ElectionsView { nations: NationElection[]; you: string | null }

const j = async <T>(r: Response): Promise<T> => {
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* non-json */ } throw new Error(m); }
  return r.json() as Promise<T>;
};

/** A handle to one live server. `base` is its origin (e.g. http://127.0.0.1:8787). */
export class AceServer {
  constructor(public base: string) { this.base = base.replace(/\/$/, ''); }

  world(): Promise<WorldSummary> { return fetch(`${this.base}/world`).then(r => j<WorldSummary>(r)); }
  circuit(): Promise<CircuitView> { return fetch(`${this.base}/circuit`).then(r => j<CircuitView>(r)); }
  /** The World Cup — national teams by nationality, the bracket, the full-simmed final. */
  worldCup(): Promise<WorldCupView> { return fetch(`${this.base}/worldcup`).then(r => j<WorldCupView>(r)); }
  /** National-team manager elections (with a Bearer, includes your own status). */
  worldCupElections(token?: string): Promise<ElectionsView> {
    return fetch(`${this.base}/worldcup/elections`, token ? { headers: { authorization: `Bearer ${token}` } } : {}).then(r => j<ElectionsView>(r));
  }
  /** Stand as a candidate to manage a nation (you must own a club). */
  runForNation(code: string, token: string): Promise<{ ok: boolean; manager: string }> { return this.post(`/worldcup/${code}/run`, {}, token); }
  /** Back a candidate (by their club tag) to manage a nation. */
  voteNation(code: string, candidateTag: string, token: string): Promise<{ ok: boolean; manager: string }> { return this.post(`/worldcup/${code}/vote`, { candidateTag }, token); }
  /** As the elected manager, author the nation's tactics (drives the engine-simmed final). */
  setNationTactics(code: string, tactics: Tactics, token: string): Promise<{ ok: boolean }> {
    return fetch(`${this.base}/worldcup/${code}/tactics`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ tactics }) }).then(r => j<{ ok: boolean }>(r));
  }
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
  /** Your notification inbox (targeted events) + unread count. */
  notifications(token: string): Promise<{ items: Notif[]; unread: number }> {
    return fetch(`${this.base}/notifications`, { headers: { authorization: `Bearer ${token}` } }).then(r => j<{ items: Notif[]; unread: number }>(r));
  }
  /** Mark one notification (by id) or all (omit) read. */
  markNotifsRead(token: string, id?: number): Promise<{ ok: boolean; unread: number }> { return this.post('/notifications/read', id == null ? {} : { id }, token); }

  // ── owner-to-owner mail (human-to-human) ──
  /** Your mail inbox + unread count. */
  mail(token: string): Promise<{ items: MailMsg[]; unread: number }> {
    return fetch(`${this.base}/mail`, { headers: { authorization: `Bearer ${token}` } }).then(r => j<{ items: MailMsg[]; unread: number }>(r));
  }
  /** The other human-owned clubs you can message. */
  mailRecipients(token: string): Promise<{ recipients: { tag: string; name: string }[] }> {
    return fetch(`${this.base}/mail/recipients`, { headers: { authorization: `Bearer ${token}` } }).then(r => j<{ recipients: { tag: string; name: string }[] }>(r));
  }
  /** Send a new message to another human-owned club. */
  sendMail(token: string, toTag: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }> { return this.post('/mail/send', { toTag, subject, body }, token); }
  /** Reply within a thread — the recipient + subject are derived from the message. */
  replyMail(token: string, replyTo: number, body: string): Promise<{ ok: boolean; error?: string }> { return this.post('/mail/send', { replyTo, body }, token); }
  /** Mark one message (id), a whole thread (threadId), or all read. */
  markMailRead(token: string, opts?: { id?: number; threadId?: number }): Promise<{ ok: boolean; unread: number }> { return this.post('/mail/read', opts ?? {}, token); }

  // ── live chat (real-time, SSE) — rooms ('global' | 'div:<tier>:<group>') + presence ──
  /** Subscribe to a chat room. `onBacklog` fires once with recent history, `onMessage`
   *  per new message, `onPresence` with the online club tags (a `token` identifies you
   *  for presence). Returns an unsubscribe fn. */
  chatStream(room: string, token: string | null, onBacklog: (msgs: ChatMsg[]) => void, onMessage: (m: ChatMsg) => void, onPresence: (tags: string[]) => void): () => void {
    const es = new EventSource(`${this.base}/chat/stream/${encodeURIComponent(room)}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    es.addEventListener('backlog', e => { try { onBacklog(JSON.parse((e as MessageEvent).data) as ChatMsg[]); } catch { /* ignore */ } });
    es.addEventListener('presence', e => { try { onPresence(JSON.parse((e as MessageEvent).data) as string[]); } catch { /* ignore */ } });
    es.onmessage = e => { try { onMessage(JSON.parse(e.data) as ChatMsg); } catch { /* keepalive */ } };
    return () => es.close();
  }
  /** Post a message to a room ('global' or your own division room). */
  sendChat(token: string, room: string, text: string): Promise<{ ok: boolean; error?: string }> { return this.post('/chat/send', { room, text }, token); }
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
  /** The live-watch source: the timeline gated to the broadcast position (completed
   *  rounds only, spoiler-safe), or the full timeline once resolved. Poll it while
   *  watching live — `completed` grows as rounds finish; `resolved` flips at reveal. */
  liveTimeline(season: number, day: number, slot: number): Promise<LiveTimeline> {
    return fetch(`${this.base}/fixtures/${season}/${day}/${slot}/live`).then(r => j<LiveTimeline>(r));
  }

  // ── identity + ownership (self-owned auth → claim a club → author its plan) ──
  private post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return fetch(`${this.base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(r => j<T>(r));
  }
  register(email: string, password: string): Promise<RegisterResult> { return this.post('/auth/register', { email, password }); }
  login(email: string, password: string): Promise<Session> { return this.post('/auth/login', { email, password }); }
  /** Complete email verification with the token from the (emailed) link. */
  verifyEmail(token: string): Promise<{ verified: boolean; accountId: string }> { return this.post('/auth/verify', { token }); }
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
