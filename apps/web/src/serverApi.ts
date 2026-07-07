// A typed client for the @ace/server live-broadcast API (apps/server/src/http.ts).
// This is the seam that turns the single-player client into the async-PvP client:
// the world resolves on the SERVER tick, and the browser watches it — live with the
// result embargo, then by re-simming the snapshot once revealed (the engine runs
// client-side, so watching still costs the server ~nothing). Read-only here; the
// ownership write-path (claim/plan) rides the same base.
import type { MatchInput, MapId, Tactics, MatchTimeline } from '@ace/shared';

export interface WorldSummary { id: string; region: string; season: number; day: number; tiers: number; layout: number[]; divisions: number; clubs: number; broadcastDay: number; lastDay: number; kickoffAt: number; revealAt: number; now: number; autoAdvanceSecs?: number; nextTickAt?: number | null; manualAdvance?: boolean }
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
export interface StaffMember { id: string; name: string; role: string; rating: number; wage: number }
export interface SponsorOffer { name: string; base: number; bonus: number; goal: string; goalN: number; years: number; goalText?: string }
export interface AttrScout { key: string; cur: number; ceil: number; mech: boolean }
export interface MarketEntry { handle: string; role: string; age: number; overall: number; value: number; contested: boolean; ceiling: [number, number]; scoutLevel: number; attrs: AttrScout[] }
export interface ScoutResult { ok: boolean; reason?: string; level: number; cost?: number; nextCost?: number | null; ceiling: [number, number]; balance?: number }
export interface BidResult { ok: boolean; reason?: string; leader?: string; leadBid?: number; paid?: number; club?: ClubPage }
export interface SquadPlayer { id: string; handle: string; role: string; age: number; overall: number; value: number; starter: boolean; igl: boolean; fatigue: number; injury: number; wage: number; contractYears: number; renew: number; ceiling: [number, number]; room: number; attrs: AttrScout[]; agents: { agent: string; level: number }[]; focus: string | null; mentor: boolean; mentee: boolean; mood: number; captain: boolean; loan?: { tag: string; tier: number } | null; renewTerms?: { years: number; wage: number }[]; accolades?: string[] }
export interface TalkRead { fit: 'great' | 'ok' | 'poor'; edge: number; mood: number }
export interface CareerEntry { season: number; tier: number; divName: string; finish: number; champion: boolean; promoted: boolean; relegated: boolean; cupWon: boolean; intlWon: boolean; briefMet: boolean }
export interface SaleResult { ok: boolean; reason?: string; fee?: number; buyer?: string; club?: ClubPage }
export interface FivePlayer { handle: string; role: string; overall: number; igl: boolean; solo?: string; soloTier?: string; agent?: string; trait?: string | null; name?: string; country?: string; flag?: string; age?: number; accolades?: string[] }
export interface ClubPlan { tactics: Tactics; comp?: Record<string, string>; lineup?: string[] }
export interface Prospect { id: string; handle: string; role: string; age: number; overall: number; ceiling: [number, number]; room: number; scoutLevel: number; attrs: AttrScout[] }
export interface AcademyView { level: number; max: number; cost: number | null; canUpgrade: boolean; upkeep: number; intakeNext: number; wageBill: number; prospects: Prospect[] }
export interface Dossier { attack: string; defense: string; lurk: boolean; counter: string; smoke?: string | null; kit?: string[] }
export interface ClubPage { tag: string; name: string; tier: number; group: number; titles: number; intlTitles?: number; owned: boolean; rating: number; phase?: string; style?: { archetype: string; label: string } | null; dossier?: Dossier | null; five: FivePlayer[]; plan?: ClubPlan; balance?: number; squad?: SquadPlayer[]; academy?: AcademyView; division?: string; power?: number; powerRank?: number | null; totalClubs?: number; infra?: number; wcTitles?: number; cupTitles?: number; facilities?: { bootcamp: number; recovery: number; analyst: number }; facilityUpkeep?: number; staff?: Record<string, StaffMember>; staffMarket?: Record<string, StaffMember[]>; staffWageBill?: number; sponsor?: (SponsorOffer & { yearsLeft: number }) | null; sponsorOffers?: SponsorOffer[]; objective?: { kind: string; label: string; needRank: number; bonus: number } | null; objectiveRank?: number; boardConfidence?: number; boardStatus?: { key: string; label: string }; boardOutcome?: { met: boolean; label: string; bonus: number; finish: number } | null; teamTalk?: string | null; talkReads?: Record<string, TalkRead>; squadMood?: number; favourite?: 'fav' | 'dog' | 'even'; rival?: { tag: string; name: string } | null; derbyRecord?: { w: number; l: number }; nextDerby?: boolean; camp?: string | null; campOpen?: boolean; cohesion?: number; career?: CareerEntry[]; leagueTitles?: number; form?: { r: string; us: number; them: number; opp: string; day: number }[]; record?: { w: number; l: number }; standing?: number | null; divSize?: number; vsYou?: { tag: string; power: number; w: number; l: number; played: number }; vip?: boolean; vipUntil?: number | null; plays?: Record<string, { attack?: unknown; attack2?: unknown; defense?: unknown }>; planFive?: { id: string; handle: string; role: string; utility: number }[]; playbookMaps?: string[] }

export interface LeaderRow { rank: number; handle: string; name?: string; flag?: string; role: string; age: number; overall: number; soloLabel: string; soloTier: string; club: string; clubTag: string; tier: number; owned: boolean }
export interface ClubRankRow { rank: number; tag: string; name: string; tier: number; group: number; power: number; phase: string; infra: number; titles: number; owned: boolean }
export interface NewsItem { kind: 'transfer' | 'champion' | 'season' | 'award'; text: string; season: number; day: number }
export interface StatRow { rank: number; handle: string; club: string; role: string; kills: number; deaths: number; matches: number; fb: number; mvp: number; kd: number; hsPct?: number; clutch?: number }
export interface Notif { id: number; kind: 'fixture' | 'result' | 'season' | 'award' | 'system'; text: string; season: number; day: number; read: boolean; at: number }
export interface MailMsg { id: number; threadId: number; fromTag: string; fromName: string; toTag: string; subject: string; body: string; season: number; day: number; read: boolean; mine: boolean; at: number }
export interface ChatMsg { id: number; room: string; fromTag: string; fromName: string; text: string; at: number }
export interface TransferOffer { id: number; fromTag: string; toTag: string; handle: string; amount: number; status: 'pending' | 'accepted' | 'declined' | 'withdrawn'; season: number; day: number }
export interface PlayoffGameView { seed: number; map: string; score: [number, number]; winner: string }
export interface PlayoffSeriesView { label: string; need: number; hi: string; lo: string; wins: [number, number]; winner: string; veto: { team: string; action: string; map: string }[]; games: PlayoffGameView[] }
export interface PlayoffView { season: number; qualified: string[]; rounds: PlayoffSeriesView[][]; champion: string }
export interface FriendlyRow { id: number; at: number; season: number; day: number; map: string; home: ClubLabel; away: ClubLabel; score: [number, number] }
export interface ScheduleRow { day: number; slot: number; map: MapId; home: string; away: string; status: string }

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
export interface WCGroupRow { code: string; country: string; flag: string; w: number; l: number; rd: number; pts: number; through: boolean }
export interface WCGame { id: string; a: WCSide; b: WCSide; score: [number, number]; map: MapId }
export interface WCKO extends WCGame { round: number; winner: WCSide }
export interface WorldCupView {
  season: number;
  squads: { code: string; country: string; flag: string; strength: number; pool: number; manager: string | null; custom: boolean; five: WCPlayer[] }[];
  groups: { name: string; rows: WCGroupRow[]; games: WCGame[] }[];
  bracket: { field: WCSide[]; rounds: WCKO[][]; champion: WCSide };
  third: WCKO | null;
  boot: { handle: string; name: string; code: string; flag: string; kills: number; games: number } | null;
  final: { a: WCSide; b: WCSide; map: MapId; score: [number, number]; id: string };
}
export interface PoolPlayer { id: string; handle: string; name: string; role: string; overall: number }
export interface NationElection {
  code: string; country: string; flag: string;
  manager: string | null;                                   // the elected manager's club tag
  candidates: { tag: string; votes: number; you: boolean }[];
  hasTactics: boolean; custom: boolean; youCandidate: boolean; youManager: boolean;
  yourVoteTag: string | null;                               // who you backed
  tactics?: Tactics;                                        // present only if you're the manager
  pool?: PoolPlayer[];                                       // the eligible pool (manager only)
  fielded?: string[];                                        // the current fielded five's ids (manager only)
  comp?: Record<string, string>;                             // the manager's per-player agent picks
}
export interface WorldCupHonors {
  history: { season: number; code: string; country: string; flag: string; managerTag: string | null; managerAccount: string | null }[];
  managers: { tag: string; titles: number }[];
  nations: { code: string; country: string; flag: string; titles: number }[];
}
export interface ElectionsView { nations: NationElection[]; you: string | null }
// the domestic ACE Cup (every club, open draw, full-simmed on the watchable ties)
export interface CupClubRef { idx: number; tag: string; name: string; tier: number }
export interface CupTieView { id: string; home: CupClubRef; away: CupClubRef; score: [number, number]; map: MapId; winner: number; watchable: boolean }
export interface CupView {
  season: number;
  rounds: { round: number; name: string; ties: CupTieView[]; byes: CupClubRef[] }[];
  champion: CupClubRef | null;
  upsets: { w: CupClubRef; l: CupClubRef }[];
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
  /** The World Cup — national teams, the group stage, the knockout, all engine-simmed. */
  worldCup(): Promise<WorldCupView> { return fetch(`${this.base}/worldcup`).then(r => j<WorldCupView>(r)); }
  /** A watchable World Cup game's snapshot by id (group/knockout/third/final) — re-sim it. */
  worldCupReplay(gameId: string): Promise<{ snapshot: MatchInput }> { return fetch(`${this.base}/worldcup/replay/${encodeURIComponent(gameId)}`).then(r => j<{ snapshot: MatchInput }>(r)); }
  /** The domestic ACE Cup — every club entered, open draw, full-simmed on the watchable ties. */
  cup(): Promise<CupView> { return fetch(`${this.base}/cup`).then(r => j<CupView>(r)); }
  /** A watchable cup tie's snapshot by id — re-sim it in the viewer. */
  cupReplay(tieId: string): Promise<{ snapshot: MatchInput }> { return fetch(`${this.base}/cup/replay/${encodeURIComponent(tieId)}`).then(r => j<{ snapshot: MatchInput }>(r)); }
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
  /** As the elected manager, pick the XI from the eligible pool (a valid five). */
  setNationLineup(code: string, lineup: string[], token: string): Promise<{ ok: boolean }> {
    return fetch(`${this.base}/worldcup/${code}/lineup`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ lineup }) }).then(r => j<{ ok: boolean }>(r));
  }
  /** As the elected manager, pick each player's agent (the comp). */
  setNationComp(code: string, comp: Record<string, string>, token: string): Promise<{ ok: boolean }> {
    return fetch(`${this.base}/worldcup/${code}/comp`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ comp }) }).then(r => j<{ ok: boolean }>(r));
  }
  /** The World Cup legacy — past champions (nation + manager) + the title boards. */
  worldCupHonors(): Promise<WorldCupHonors> { return fetch(`${this.base}/worldcup/honors`).then(r => j<WorldCupHonors>(r)); }
  /** The Hall of Fame — season champions + all-time title leaders (the legacy engine). */
  honors(): Promise<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[]; awards?: { season: number; mvp: { handle: string; club: string; kills: number } | null; youngGun: { handle: string; club: string; kills: number; age: number } | null }[] }> {
    return fetch(`${this.base}/honors`).then(r => j<{ honors: { season: number; champion: string }[]; allTime: { tag: string; name: string; titles: number }[] }>(r));
  }
  /** A club's public page (identity, division, the fielded five) — read-only. */
  club(slug: string, token?: string): Promise<ClubPage> { return fetch(`${this.base}/clubs/${slug}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}).then(r => j<ClubPage>(r)); }
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
  careerStats(): Promise<{ players: (StatRow & { seasons?: number })[] }> { return fetch(`${this.base}/stats/career`).then(r => j(r)); }
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
  /** The WORLD EVENT STREAM — the live-sync spine. One SSE connection carrying
   *  sequence-numbered events (`hello`/`day`/`reveal`/`season`/`news`/`market` +
   *  account-targeted `notif`/`mail`). EventSource auto-reconnects presenting
   *  Last-Event-ID, the server replays the missed tail, and a gap it can't cover
   *  arrives as `resync` — so the caller's `onResync` (full refetch) is the
   *  guarantee that a client is never silently stale. Returns unsubscribe. */
  events(token: string | null, onEvent: (ev: string, data: Record<string, unknown>) => void, onResync: () => void): () => void {
    const es = new EventSource(`${this.base}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    for (const ev of ['hello', 'day', 'reveal', 'season', 'news', 'market', 'notif', 'mail']) {
      es.addEventListener(ev, e => { try { onEvent(ev, JSON.parse((e as MessageEvent).data || '{}')); } catch { /* keepalive */ } });
    }
    es.addEventListener('resync', () => onResync());
    return () => es.close();
  }
  /** A division's full season schedule — every fixture's day, clubs, STATUS and
   *  (seed-derived, knowable in advance) MAP: the published rotation a manager
   *  prepares his playbook against. */
  schedule(tier: number, group = 0): Promise<{ tier: number; group: number; matchdays: ScheduleRow[][] }> {
    return fetch(`${this.base}/schedule/${tier}/${group}`).then(r => j(r));
  }
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
  /** The managers online right now (live event-stream connections → club tags). */
  presence(): Promise<{ online: number; tags: string[] }> { return fetch(`${this.base}/presence`).then(r => j(r)); }
  /** The Premier playoff brackets (engine-simmed at each rollover, watchable). */
  playoffs(): Promise<{ history: PlayoffView[] }> { return fetch(`${this.base}/playoffs`).then(r => j(r)); }
  playoffReplay(season: number, seed: number): Promise<{ snapshot: MatchInput }> {
    return fetch(`${this.base}/playoffs/${season}/${seed}/replay`).then(r => j(r));
  }

  /** Challenge a club to a FRIENDLY — resolved instantly with the real engine
   *  (your playbooks/fitness/morale all bite), watchable at once, standings
   *  untouched. Works vs another human's club or any AI club (a scrim). */
  loanOut(token: string, playerId: string): Promise<{ ok: boolean; reason?: string; loan?: { tag: string; tier: number } }> {
    return this.post('/loan', { id: playerId }, token);
  }
  recallLoan(token: string, playerId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.post('/loan/recall', { id: playerId }, token);
  }
  offerTransfer(token: string, tag: string, handle: string, amount: number): Promise<{ ok: boolean; offer?: TransferOffer; error?: string }> {
    return this.post('/transfer/offer', { tag, handle, amount }, token);
  }
  respondTransfer(token: string, id: number, accept: boolean): Promise<{ ok: boolean; reason?: string; offer?: TransferOffer; error?: string }> {
    return this.post('/transfer/respond', { id, accept }, token);
  }
  withdrawTransfer(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
    return this.post('/transfer/withdraw', { id }, token);
  }
  transfers(token: string): Promise<{ incoming: TransferOffer[]; outgoing: TransferOffer[] }> {
    return fetch(`${this.base}/transfers`, { headers: { authorization: `Bearer ${token}` } }).then(r => j(r));
  }
  challenge(token: string, tag: string): Promise<{ ok: boolean; id: number; map: string; score: [number, number]; home: ClubLabel; away: ClubLabel; human: boolean; error?: string }> {
    return this.post('/challenge', { tag }, token);
  }
  friendlies(token: string): Promise<{ friendlies: FriendlyRow[]; h2h: Record<string, { w: number; l: number }> }> {
    return fetch(`${this.base}/friendlies`, { headers: { authorization: `Bearer ${token}` } }).then(r => j(r));
  }
  friendlyReplay(fid: number): Promise<{ snapshot: MatchInput; score: [number, number]; home: ClubLabel; away: ClubLabel; map: string }> {
    return fetch(`${this.base}/friendlies/${fid}/replay`).then(r => j(r));
  }

  /** Set/clear one slot of your PER-MAP playbook — what your club fields when a
   *  fixture lands on that map. Sanitized server-side at the write boundary. */
  setPlay(token: string, map: string, slot: 'attack' | 'attack2' | 'defense', play: unknown | null): Promise<{ ok: boolean; plays?: Record<string, unknown>; error?: string }> {
    return this.post('/me/play', { map, slot, play }, token);
  }

  /** Start a VIP subscription. Dev servers (no Stripe secret) activate instantly;
   *  production returns the hosted-checkout URL and the webhook flips VIP. */
  checkoutVip(token: string): Promise<{ dev?: boolean; vip?: boolean; vipUntil?: number; url?: string }> { return this.post('/billing/checkout', {}, token); }

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
  /** Re-sign a player to a fresh deal at his current market wage (re-locks his wage). */
  renew(playerId: string, token: string, years?: number): Promise<{ ok: boolean; squad?: SquadPlayer[] }> { return this.post('/me/renew', { playerId, years }, token); }
  /** Direct a player's training at one skill (grows faster, the rest slower). attr null clears. */
  setFocus(playerId: string, attr: string | null, token: string): Promise<{ ok: boolean; error?: string; squad?: SquadPlayer[] }> { return this.post('/me/focus', { playerId, attr }, token); }
  /** Set the pre-match team talk tone (calm/rally/demand); it lands next match then clears. */
  setTalk(tone: string | null, token: string): Promise<{ ok: boolean; teamTalk?: string | null }> { return this.post('/me/talk', { tone }, token); }
  /** Name the club captain (a leader steadies + lifts the room); null clears to the auto pick. */
  setCaptain(playerId: string | null, token: string): Promise<{ ok: boolean; error?: string; squad?: SquadPlayer[] }> { return this.post('/me/captain', { playerId }, token); }
  /** Pick the pre-season training camp (fitness/chemistry/sharpness); only in the early window. */
  setCamp(camp: string | null, token: string): Promise<{ ok: boolean; error?: string; camp?: string | null }> { return this.post('/me/camp', { camp }, token); }
  /** Build/expand an HQ room (charges the club balance; boost applies at the next tick). */
  upgradeFacility(room: string, token: string): Promise<{ ok: boolean; reason?: string; cost?: number; facilities?: { bootcamp: number; recovery: number; analyst: number }; balance?: number; facilityUpkeep?: number }> { return this.post('/me/facility', { room }, token); }
  /** Hire a backroom staffer from the shortlist (no fee, a recurring wage) or release one. */
  staffAction(body: { role: string; id?: string; release?: boolean }, token: string): Promise<{ ok: boolean; staff?: Record<string, StaffMember>; staffWageBill?: number }> { return this.post('/me/staff', body, token); }
  /** Sign one of the three offered multi-season sponsorship deals (paid at each settle). */
  signSponsor(index: number, token: string): Promise<{ ok: boolean; reason?: string; sponsor?: SponsorOffer & { yearsLeft: number } }> { return this.post('/me/sponsor', { index }, token); }

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
