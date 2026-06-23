# ACE — Design Bible
### *A persistent, player-run Valorant esports management simulation for the browser*

> **Working codename:** ACE (placeholder — naming TBD). Spiritual successor to **cs-manager.com**, rebuilt for Valorant and pushed to the ceiling of what the genre can be.

---

## 1. The Pitch

Football Manager's depth, a living Valorant esports universe, and a broadcast booth — in your browser.

You found **one** organization and run it **forever**. You scout and develop human-feeling players, build comps and tactics, manage a business and a brand, and compete **asynchronously** against thousands of other real owners inside a single persistent world that writes its own history — dynasties, rivalries, breakout prospects, market panics — with broadcast-quality match replays and AI in the commentary booth.

Nobody has built this. The pieces exist in scattered form (FM's depth, fantasy sports' async PvP, the old browser-manager social leagues), but no one has fused them around a modern esport with a public, spectator-grade world layer.

---

## 2. North Star & Design Pillars

**The thesis: the community is the content.** A persistent world of thousands of human-run orgs produces an endless, *unauthored* competitive narrative. We don't write storylines — we build the systems that generate them, then wrap them in presentation good enough to watch.

These six pillars are the tie-breakers for every design decision:

1. **Your club, forever.** Owner-founder, never manager-for-hire. One continuous story per player. There is no "career mode," no job market, no sacking — stakes live in the *health of the club*, not the security of a job.
2. **Depth through hidden information.** The game *is* the gap between what a player could be, what they are, and what shows up on the night — and the fog over all three. The fog must always be **fair and legible**: a bust is a risk you knowingly took, never the dice mugging you.
3. **Server-authoritative & asynchronous.** Matches resolve on a server tick, identical for everyone, whether or not anyone watches. There is **no real-time match netcode**. This single decision is what makes a deep PvP browser game possible at all.
4. **The world is a spectator sport.** Every match is a public, shareable replay. Club pages, broadcast, and following are first-class surfaces, not afterthoughts. A 16–14 over the #1 seed is a *link you drop in Discord*.
5. **Emergent, not authored.** The meta, the rankings, the rivalries, the market — all arise from aggregate play. Build systems; let the players write the history.
6. **Manifest the player.** A great org converts latent potential into greatness; a bad one wastes it. You are genuinely consequential to a human-feeling career.

---

## 3. Lineage — From cs-manager.com to ACE

cs-manager.com (CSM) was a dead-but-brilliant browser Counter-Strike manager. It had the right **bones**; almost nobody ever pushed them this far. ACE keeps every bone, swaps Counter-Strike for Valorant, and adds the persistent social world CSM never had.

| CSM (Counter-Strike) | ACE (Valorant) — pushed to its ceiling |
| --- | --- |
| Player skills (aim, IQ, awareness…) | **Three-layer model**: potential-as-a-shape behind fog → current ability → match expression; plus agent pools, roles, and an aging curve |
| Buy players PCs / upgrade server slots | **Facility & gaming-house tycoon** — rooms that raise ceilings on development, recovery, morale, and media |
| PR manager → HLTV viewers → sponsors | **Full brand & attention economy** — popularity as a genuine *second win condition* |
| Missions for points | **Self-authored ambition** + sponsor clauses — *no mandates, no sacking* |
| Tactics editor (players hoarded their strats) | **Tactics + espionage** — public replays make scouting espionage; a *familiarity* stat rewards plays you've actually drilled |
| Individual training + practice matches + fitness + LAN camps | **Weekly prep loop** with physical *and* mental load — burnout, tilt, RSI, peak-timing |
| Transfer list + tryout-reading minigame | **Contracts, promises & agents** + scouting fog-of-war + probabilistic potential + an academy pipeline |
| Divisions + national/global rankings | **The full Valorant pyramid** — open quals → Challengers → Ascension → international league → Masters → Champions, across regions, on a world calendar |
| 2D top-down match viewer (paid VIP) | **Server-tick replays** + a public **broadcast layer** — tick night, match center, auto-clips, shareable URLs |

The headline: we kept the soul (deep prep + economy + a match you can *watch*) and built a living world on top of it.

---

## 4. The Player Model — The Three Layers

This is the heart of the game. Most managers model only one layer; we model three, and the **gaps between them** are where the game lives.

- **Potential** — the latent ceiling. What this person *could* become.
- **Current ability** — what they can do right now.
- **Match expression** — what actually shows up on the server on a given night.

### 4.1 Potential is a *shape*, not a number — behind fog
A prospect does **not** have a single hidden "potential = 8/10." They have a **ceiling per attribute**, so potential has a *shape*: maybe a godlike aim ceiling, an average game-sense ceiling, an unknown clutch ceiling. Scouting stops being "how good will he get" and becomes "*what* could he be" — and the shape implies the role (raw-aim cloud → mold a duelist; high-IQ/comms ceiling → a future IGL).

Crucially, the fog is **uneven**:
- **Mechanical traits** (aim, movement, reaction) are *visible* — they leak into stats and scrims.
- **Intangibles** (composure, coachability, ego, work ethic) stay nearly *invisible* until you sign the player and live with him.

Every scouting report therefore carries a **confidence per attribute**. The market's mispriced gems are the kids whose hidden intangibles are elite but unreadable to everyone else. Your scouting + analyst department is your edge. This is the Moneyball layer.

### 4.2 Potential is probabilistic and collapses over time
A 16-year-old is a **distribution**, not a fixed unseen number — a wide cloud ("T1 superstar … or washes out of T3"). Every season of reps, training, and pressure **narrows the cloud**. Youth signings become real probability bets with fat tails: booms, busts, lottery tickets, the cheap kid from an under-scouted region who turns generational. You don't buy a player — you buy a *range*, then work to shrink the variance in your favor.

### 4.3 Development is nonlinear
Skill does not creep up a slider. The model includes:
- **Breakouts** — the rare season a player "clicks" and step-changes, unlocked by the right coach, role, or a deep playoff run.
- **Plateaus & regressions** — stalls, slumps, tilt spirals.
- **Latent attributes** — some traits stay hidden *until conditions reveal them*: a clutch gene that only surfaces in elimination rounds; a leadership trait that only appears once you hand him the IGL role. These are **discovery moments** — "I didn't know he had that in him" — that no stat creep can replicate.

### 4.4 The esports aging curve
This is where Valorant diverges hard from football. **Reflexes peak absurdly young and decline fast** — a 26-year-old is a veteran — but **game sense, leadership, and IGL instinct compound with age**. Every star has an arc baked in:

> prospect → breakout → prime fragger → aging into the IGL/anchor → coach

The duelist who can't win his duels anymore reinventing himself as the calm voice calling the round. Churned across thousands of public careers, this lifecycle **is** the legacy engine — it writes the world's history with no author.

### 4.5 The org is the manifestation engine
Potential is latent energy; your club converts it or wastes it. Game time (benching a prospect stunts him), a veteran mentor in the room, a coach whose specialty matches the player's *shape*, role fit, culture, and morale all decide whether the ceiling is reached. We go past what FM dares:
- A great environment can **unlock a hidden higher tier**.
- Neglect can **permanently cap** a kid whose window slammed shut.

This makes you truly consequential — and makes the **selling-club identity** real: be the org famous for *producing* talent (academy pipeline, public alumni hall) and rivals will come to poach what you grow.

---

## 5. Squad & Roster Management

- **Agent pools & roles.** Beyond raw attributes, each player has an **agent mastery pool** (which agents they play well, at what level) and a primary **role** — Duelist / Initiator / Controller / Sentinel. **Agent versatility is antifragile** and draftable: a flex who covers a nerf is worth paying up for.
- **Contracts.** Length, salary, buyout/release clauses, and **promises** — playing time, a starting role, a leadership slot.
- **Promises matter.** Keep them and the player buys in. Break them — bench the guy you swore would start — and morale tanks, he leaks to the press, his agent shops him, his value drops.
- **The market breathes.** Bidding wars, free agency, loans to/from academies, and **agents who haggle hard** for stars. The whole market moves with the live meta (see §7).
- **The academy.** Youth intakes, region scouting, develop-and-sell as a viable business model.

---

## 6. Tactics, Comps & The Match

### 6.1 Comp Builder (the Valorant layer CSM never had)
Assemble the five with a **live role-balance check** — almost every comp wants a controller (smokes enable everything), and the right composition shifts **by map**. Save **per-map presets**. This turns "buy good players" into "build a roster that *covers a comp*."

### 6.2 Tactics editor + espionage
A visual, map-by-map editor (attack/defense) for agent positions, ability lineups, and movement paths. Because **every match resolves into a public replay, scouting is espionage**:
- Study any opponent's recent games, read tendencies, build anti-strats — and they're doing the same to you.
- Disguise your patterns; hold a new setup for a playoff run; bait rivals into prepping for a strat you'll never run.
- A tactic carries a **familiarity** stat — a play your team has actually drilled executes cleaner. You can't just copy the world's #1 strat; your squad has to have repped it.

### 6.3 The match engine (the keystone)
A **deterministic, server-authoritative** function:

```
(team A prepared, team B prepared, patch/meta state, seed) → result + event timeline
```

- Resolves on a **server tick** (e.g., nightly), the *same* for everyone, watched or not.
- Outputs a structured **event timeline** (the "demo"): rounds, kills, plants/defuses, ability usage, economy, ult points.
- **Seeded ⇒ reproducible**: any match can be re-run from its seed to an identical result — trivial debugging, verification, and anti-dispute.
- No live netcode. "Watch live at tick time" and "watch the replay tomorrow" are the **same stored data**.

**The event-timeline contract is the single most important artifact in the codebase.** Nail it and both the simulation and the viewer fall out of it.

### 6.4 The 2D Match Viewer (the showpiece)
Top-down map replay reading the timeline: round-timeline scrubber, kill feed, economy/ult bars, plant/defuse events, agent markers and utility. Public, shareable by URL. This is the emotional payoff — the moment your prep is revealed to have worked or failed.

> **Design consequence:** the match is *non-interactive* — no mid-game calls. ~90% of the game is a deep **preparation** sim; ~10% is the viewer revealing whether the prep paid off. The match is the payoff, not the gameplay. (This is exactly why CSM could be deep without being twitchy.)

**Non-negotiable:** every manager must always have an **active plan** the engine can grab at tick time — a saved lineup + tactics per map and side, with real defaults — so a ghosting/no-show owner still fields a competent team, never five idle bots.

---

## 7. The Living Meta

- **The tier list emerges.** It is *not* hand-set — it's computed from **aggregate match data across the entire world**, and it shifts as the population's play shifts.
- **Patches reshuffle it.** Periodic Valorant-style balance patches buff/nerf agents. Nerf an agent and its specialists lose value; the market reacts in real time.
- **A genuine speculation layer.** Read the patch, buy the rising agent's specialists *before everyone else*. The sharp owner already bought low. (A market that moves — right at home for the target player.)

---

## 8. The Org as a Business

### 8.1 Facilities & the gaming house (tycoon layer)
A team HQ built room by room — bootcamp space, VOD/analyst room, sports-psych office, content studio, scrim server. Each tier raises a **ceiling** (training, recovery, morale, media output). The HQ is a *visible place* that grows with you. Out-invest in your environment and you out-develop everyone — wired straight into §4.5.

### 8.2 Brand & attention economy (CSM's most underrated idea, blown wide open)
Your org has a **brand**: viewership, social following, fan sentiment, content output. It is a genuine **second win condition** — a losing team with a magnetic superstar and a great content studio can **out-earn a boring champion**. "Entertainment brand" is a real way to play, it funds the free-to-play model, and it makes signing the flashy fan-favorite duelist a *business* decision, not just a sporting one.

### 8.3 Sponsors & finances
Choose your risk: a **flat weekly** check (safe) or a **high-variance** deal (Masters-run bonus, relegation penalty). A business gamble *you opt into* — never a mandate imposed on you. Standard income/expense ledger underneath (wages, staff, facilities, gear vs. sponsorship, prize money, brand revenue).

### 8.4 Monetization
**Free-to-play with a subscription VIP tier** — CSM's exact model. F2P is essential because a deep PvP world *needs a large free base* to keep leagues full. VIP unlocks convenience/depth (deeper analytics, more saved tactics/replays, faster scouting), never pay-to-win competitive advantage. (Stripe-backed; multi-currency.)

---

## 9. The Social Spine

**The public club page is not a sub-page — it's the spine of the whole game.** In most managers, "view opponent" is a dry stat sheet. Here it's a real, shareable destination — `league.gg/sentinels` — an esports org's site crossed with a trading-card showcase:

- Crest, colors, kit, and a **roster of collectible-style player cards** with agent specialties.
- Trophy cabinet, season-by-season history, current form & rank.
- **Rivalries** with head-to-head records; **signature wins** with embedded replay highlights.
- An **alumni hall of fame** for the stars you developed.

The unlock: **non-managers can browse and *follow* teams.** A fanbase becomes its own meta-game; your team's *presentation* becomes how you flex, intimidate, and get scouted.

### 9.1 The broadcast layer — "tick night"
Matches resolve on a tick and produce replays, so we build a **spectator sport** around it: a public schedule and a synced **match center** where the community watches top-division matches resolve *together* — live kill-feed ticker, auto-clipped highlights, the biggest matches each season becoming events people show up for. Replays are public URLs → this is also the **growth engine**.

### 9.2 The legacy engine
Develop a 16-year-old nobody into a Champions MVP and that arc is **permanently written into the world** — your club page, a global hall of fame, the player's own career page. Stars retire into coaching. Dynasties, persistent rivalries, and one-club legends accrue over seasons. That permanence, displayed publicly, is the core **retention hook**: people stay for the story they're building.

---

## 10. The World, Competition & Progression

### 10.1 The pyramid (the full Valorant structure)
Open qualifiers → **Challengers** → **Ascension** → a partnered **international league** → **Masters** → **Champions**, across regions (Americas, EMEA, Pacific, China), with a **Game Changers** circuit alongside. Tension at the top: grind the open circuit, or chase a coveted franchise slot.

### 10.2 The world calendar
The whole world runs on a **shared season calendar** — off-seasons, roster-mania transfer windows, a Champions every year that the entire playerbase is climbing toward at once.

### 10.3 Stakes without a sacking
Because **you can never be fired and never lose the club**, stakes move into the **health and status of the club itself**: relegation, a gutted roster, your golden-gen star walking in free agency, a decaying brand, the meta leaving you behind, a rival lapping you three titles to none. You can hit genuine **rock bottom** — relegated, broke, roster stripped — but it's still *your* club to drag back up.

**The comeback *is* the game.** You don't run from the wreckage; you rebuild the thing you love. A stronger engine than "the board sacks you."

### 10.4 Self-authored ambition
Nobody hands you mandates. *You* pick the mountain — first promotion, an unbeaten split, a homegrown Champions MVP, a dynasty. The game surfaces milestones and needles your rivalries, but it never threatens to take the team.

---

## 11. Co-Management

Let multiple humans run a **single org** with split roles — GM (transfers/finance), Coach (tactics/training), Analyst (scouting/espionage). Multiplayer *inside* a team, and it makes the staff fantasy real.

---

## 12. AI Systems

The match engine emits a structured event timeline, so an LLM can turn it into real output:

- **AI analyst (the killer feature)** — reviews your replay and gives actual tactical feedback: *"your B hold on Ascent leaked 70% of rounds; your sentinel over-rotated on the fake."*
- **Recaps & pressers** — written match recaps, post-match interviews, in-character socials.
- **Living personalities** — morale, locker-room drama, rivalries voiced in character. Players feel alive instead of being static trait icons.
- **AI-run orgs** — the world is **seeded and sustained** with competent AI organizations so leagues feel alive from day one and never empty out.

**Honest constraints:** LLM cost and latency are real. AI therefore runs **on the async tick and on-demand** — not on every click — which the architecture already supports. Outputs are cached and tied to events, not regenerated live.

---

## 13. Visual Design Direction

The original's dated, table-heavy look is exactly what we discard. The target is a polished, **dark, tactical esports-management** app that feels native to Valorant.

- **Palette.** Near-black base with a faint blue cast (Valorant's ~`#0F1923`); **`#FF4655` red reserved** as the signal color for primary/live/danger; off-white `#ECE8E1` text; a **teal** accent for positive/active states and "your team."
- **Role color system.** Duelist / Initiator / Controller / Sentinel each get a **fixed hue** used everywhere (roster chips, comp builder, tactics). Part of the identity *and* a scanning aid.
- **Type.** A condensed display face for headers and big numbers, paired with a clean grotesk for body. Confident **tabular numerals** for stats.
- **Shape.** Sharp, lightly-beveled card corners echoing Valorant's angular UI; thin keylines; restraint.
- **Density done right.** It's a manager sim — data-rich — but with real hierarchy and breathing room, sticky headers, and good tabular layout. Not 2010s cramped tables.
- **Motion.** Purposeful: match-viewer playback, transitions, number count-ups on results.

---

## 14. Information Architecture (Screens)

Persistent left nav + a top bar carrying club identity, currency, the match-day countdown, and notifications.

1. **HQ** — daily report, next-match countdown, finances + squad health at a glance, patch notes.
2. **Squad → Player detail** — cards with an attributes radar, agent mastery pool, role, fitness, traits, contract.
3. **Comp Builder** — assemble the five, live role-balance check, per-map presets.
4. **Tactics** — map-by-map, attack/defense; agent positions + ability lineups + movement paths.
5. **Training & Staff** — assignments, load management, coaches, facilities.
6. **Scouting / Transfers / Academy** — market, free agency, youth pipeline, scout reports with confidence-per-attribute fog.
7. **Finances** — balance, sponsors, brand/viewership revenue, expenses, contracts.
8. **Competition** — the VCT-style ladder, standings, brackets, regional + global rankings.
9. **Public Club Page** — the social spine (§9); the obvious first screen to design.
10. **Match Center** — public schedule, tick-night viewing, the 2D viewer, auto-clips.
11. **Inbox / Notifications** — board notes, agent messages, press, milestones.

---

## 15. Technical Architecture

- **Server-authoritative everything.** Because it's all PvP, no match logic can live on the client (desync + cheating). Sim, economy, scheduling, matchmaking, and persistence all live on the server.
- **The deterministic seeded engine.** Inputs: two prepared teams + patch/meta state + seed. Outputs: result + JSON event timeline. Pure, reproducible, re-runnable.
- **Scheduled tick resolution.** League matches resolve on a tick (nightly/seasonal). Maps directly onto job infrastructure (BullMQ / scheduled workers).
- **Thin reactive client.** Management tables/forms, a drag-drop tactics editor (Canvas/SVG), and a 2D replay viewer (PixiJS/Canvas) that animates the stored timeline. Replays are pure data ⇒ shareable by URL.
- **Real-time only where it earns it.** WebSockets for synced tick-night viewing, transfer-market pings, and notifications. **Never** the sim itself.
- **AI integration.** Anthropic API on the tick + on-demand; outputs cached against events.
- **Proposed stack.** NestJS backend, Supabase (Postgres + auth), Stripe billing, Vue 3 + TypeScript front end. (Home turf — and structurally close to breakerlabs: scheduled jobs + subscription billing + multi-tenant.)
- **Distribution.** One web codebase → browser game + installable **PWA** (home-screen, app-like) + optional **Tauri/Electron** desktop wrapper (even a Steam storefront listing later). Build once, distribute everywhere.

---

## 16. Open Design Problems (The Hard Parts)

These are the genuinely unsolved bits — flagged honestly, none a reason to compromise the vision:

1. **The long tail of inactive clubs.** If every human founds a forever-club, some owners drift away. Need: inactive clubs handed to **AI stewardship**, allowed to slide down the pyramid, and **revivable**. Keeps the world permanent instead of cluttered with husks.
2. **New-owner entry into a deep world.** A brand-new owner must be able to enter a pyramid that's already seasons deep **without** starting at the bottom of an empty ladder. (Regional/seasonal intake waves? An expansion tier? Inheriting a steward-run club?)
3. **Fairness & legibility of fog.** Hidden information only sings if a bust feels like a *risk you took*. Feedback loops must be clean and honest.
4. **AI cost & latency at world scale.** Thousands of orgs × recaps/analysis. Aggressive caching, batching on the tick, tiered generosity (VIP gets more), cheap models for bulk text.
5. **Match-engine balance & exploit-resistance.** The sim must be deep enough to reward good prep but resistant to a single dominant degenerate strat. Continuous data-driven balancing.
6. **Account integrity.** Smurfs/multi-accounts/market collusion in a persistent economy. Detection + economic friction.

---

## 17. The Launch Roadmap

Sequenced **build-order, not calendar** — size each phase to your own pace. The ordering is deliberate: **riskiest, most foundational things first**, and a *playable, fun core loop before any depth*.

### Phase 0 — The Engine Keystone *(de-risk the whole project)*
**Goal:** prove a match resolves and replays compellingly.
**Build:** the deterministic seeded match engine; the **event-timeline contract**; the 2D viewer reading that timeline; the core data model. No accounts, no world — just feed two rosters + tactics in, watch a believable match come out.
**Gate:** a simulated 13-round match is fun to *watch* and its outcome feels earned by the inputs. *If this isn't fun, nothing downstream matters.*

### Phase 1 — Vertical Slice *(prove the loop, solo vs. AI)*
**Goal:** the core prep→resolve→learn→adjust loop is compelling against AI orgs.
**Build:** roster + a basic version of the three-layer player model; comp builder; basic tactics; a training tick; a finances tick; one screen each; the HQ dashboard.
**Gate:** a solo player wants to play "one more match-day."

### Phase 2 — The World & Persistence *(multi-tenant async PvP)*
**Goal:** a real persistent world with real owners.
**Build:** accounts (Supabase auth); persistent clubs; the league/pyramid structure; **scheduled tick resolution at scale**; **AI-run orgs to fill the leagues**; the **public club page** (social-spine MVP); shareable replays.
**Gate:** dozens of humans + AI orgs run a full season; the world feels alive and persistent.

### Phase 3 — Depth Systems *(the simulation matures)*
**Goal:** the systems that create long-term mastery and stories.
**Build:** scouting fog + academy + the full nonlinear development model; contracts/promises/agents; the transfer market; facilities/HQ; the brand & sponsor economy; the **emergent meta + patches**.
**Gate:** developing and selling a homegrown star, and reading the meta to beat the market, both feel great.

### Phase 4 — The Broadcast & Social Layer *(the growth engine)*
**Goal:** make the world a spectator sport people pull others into.
**Build:** tick-night match center; following/fandom; hall of fame + legacy; persistent rivalries; auto-clips; polished shareable replay pages.
**Gate:** a great result is something players *want* to share, and non-players follow teams.

### Phase 5 — The AI Layer *(the differentiator)*
**Goal:** AI in the booth and at the analyst desk.
**Build:** AI analyst feedback on replays; recaps/pressers; living player personalities. *(Gated on the cost/latency design from §16.4.)*
**Gate:** the analyst gives feedback a real coach would respect, within budget.

### Phase 6 — Beta → Launch *(harden & monetize)*
**Goal:** balanced, economically sound, and live.
**Build:** closed beta → economy/meta tuning → **Stripe VIP** monetization → open beta → launch. Anti-cheat/integrity, onboarding for new owners, performance at scale.
**Gate:** a healthy, self-sustaining live world.

### Post-Launch — Live Ops *(the game is a service)*
Seasonal patches & meta balance; new agents/maps tracking real Valorant; the **Game Changers** circuit; **co-management**; the **long-tail stewardship** system; community tools. The world keeps living.

---

## 18. Guiding Principles for the Build

- **Engine-first.** The match engine + timeline contract is the foundation everything else stands on. Build it before anything pretty.
- **Ship the loop before the depth.** A fun core loop with shallow systems beats a deep system with no loop.
- **The fog must be fair.** Every hidden-information system needs a clean, honest feedback loop. Legible risk, always.
- **AI on the tick, not the click.** Cache against events; batch on resolution; never block a click on an LLM call.
- **Seed the world.** AI orgs make the world alive from day one and carry it through the long tail.
- **Replays are URLs.** Everything public, everything shareable. Distribution is a feature, not an afterthought.
- **Your club, forever.** When a design choice threatens that promise, the design choice is wrong.

---

*End of bible v0.1 — a living document. Next: design the pixels, starting with the public club page (the heart of the world).*
