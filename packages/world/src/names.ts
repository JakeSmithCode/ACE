// Name pools for procedurally generated clubs and players. Curated to feel like
// a real Valorant esports ecosystem — drawn deterministically (seeded), without
// replacement, so a generated world never collides handles.

/** Club identities: a distinct name + a 3-letter tag. The sample teams (NCT,
 *  MRD) live in the engine; these fill the rest of a league. */
export const CLUB_IDENTITIES: { name: string; tag: string }[] = [
  { name: 'Vanguard', tag: 'VGD' }, { name: 'Eclipse', tag: 'ECL' },
  { name: 'Tempest', tag: 'TMP' }, { name: 'Phantom', tag: 'PHM' },
  { name: 'Cobalt', tag: 'CBT' }, { name: 'Inferno', tag: 'INF' },
  { name: 'Mirage', tag: 'MRG' }, { name: 'Sentinel', tag: 'SNT' },
  { name: 'Ronin', tag: 'RON' }, { name: 'Halcyon', tag: 'HAL' },
  { name: 'Obsidian', tag: 'OBS' }, { name: 'Specter', tag: 'SPC' },
  { name: 'Aurora', tag: 'AUR' }, { name: 'Vertex', tag: 'VTX' },
  { name: 'Zenith', tag: 'ZEN' }, { name: 'Riptide', tag: 'RPT' },
  { name: 'Maelstrom', tag: 'MLS' }, { name: 'Citadel', tag: 'CTD' },
  { name: 'Onyx Collective', tag: 'ONX' }, { name: 'Solaris', tag: 'SOL' },
  { name: 'Ironclad', tag: 'IRN' }, { name: 'Nebula', tag: 'NBL' },
  { name: 'Quasar', tag: 'QSR' }, { name: 'Tundra', tag: 'TND' },
];

/** Procedural club-name parts — an adjective + a collective noun ("Crimson
 *  Vipers", "Astral Dynasty"). The curated identities above are used first; these
 *  fill an arbitrarily deep pyramid (and, later, a server world of thousands). */
export const CLUB_ADJ: string[] = [
  'Crimson', 'Azure', 'Golden', 'Shadow', 'Frost', 'Ember', 'Obsidian', 'Radiant',
  'Savage', 'Royal', 'Rogue', 'Lunar', 'Solar', 'Void', 'Storm', 'Astral',
  'Vivid', 'Scarlet', 'Cobalt', 'Iron', 'Wild', 'Silent', 'Twilight', 'Eternal',
  'Rapid', 'Grand', 'Northern', 'Apex', 'Crystal', 'Velvet', 'Burning', 'Ivory',
];
export const CLUB_NOUN: string[] = [
  'Vipers', 'Wolves', 'Titans', 'Ravens', 'Dragons', 'Sentinels', 'Outlaws', 'Phantoms',
  'Hunters', 'Guardians', 'Foxes', 'Sharks', 'Falcons', 'Serpents', 'Reapers', 'Knights',
  'Wardens', 'Surge', 'Dynasty', 'Union', 'Syndicate', 'Collective', 'Vanguard', 'Legion',
  'Brigade', 'Crusaders', 'Mavericks', 'Rebels', 'Pioneers', 'Empire', 'Comets', 'Jaguars',
];

/** Syllable parts for coined gamer tags (VEX+AR → "VEXAR") — the procedural
 *  overflow once the curated handles run out, so the pool stays word-like (not
 *  "NOVA4") deep into the ladder. */
export const HANDLE_PRE: string[] = [
  'VEX', 'ZAR', 'KOR', 'NYX', 'RAV', 'THO', 'DRA', 'SOL', 'VYR', 'KAI', 'ZEN', 'BRY',
  'QOR', 'LUX', 'PYR', 'GRA', 'VOR', 'SYN', 'KRY', 'AXL', 'NEV', 'RHO', 'SKY', 'TYR',
];
export const HANDLE_SUF: string[] = ['AR', 'ON', 'IX', 'US', 'EL', 'YN', 'OR', 'AX', 'EN', 'IS', 'OS', 'UL', 'YX', 'AN'];

/** Curated player handles — the in-game names, seeding the procedural pool
 *  (`genHandles`) that scales it to any world size. */
export const HANDLES: string[] = [
  'AXIOM', 'BLAZE', 'CIPHER', 'DRIFT', 'EMBER', 'FROST', 'GHOST', 'HAVOC',
  'IRIS', 'JOLT', 'KESTREL', 'LUMEN', 'MIRAGE', 'NOVA', 'ONYX', 'PRISM',
  'QUILL', 'RIFT', 'SABLE', 'TALON', 'UMBRA', 'VAPOR', 'WARDEN', 'XENO',
  'YONDER', 'ZEPHYR', 'ARGON', 'BISHOP', 'CRANE', 'DUSK', 'ECHO', 'FABLE',
  'GLITCH', 'HALO', 'IDOL', 'JACKAL', 'KILO', 'LYNX', 'MANTIS', 'NEXUS',
  'ORBIT', 'PIVOT', 'QUARTZ', 'RAVEN', 'SCOUT', 'TEMPO', 'USHER', 'VIGIL',
  'WRAITH', 'XYLO', 'YIELD', 'ZODIAC', 'ANVIL', 'BOLT', 'COMET', 'DELTA',
  'ELM', 'FLUX', 'GRIM', 'HEX', 'INK', 'JINX', 'KITE', 'LACE',
  'MACE', 'NOMAD', 'OMEN', 'PACE', 'QUAKE', 'RUNE', 'SLATE', 'TITAN',
  'ULTRA', 'VOID', 'WISP', 'XACT', 'YETI', 'ZANE', 'ASH', 'BRINE',
  'CINDER', 'DOZER', 'EAGLE', 'FANG', 'GAUGE', 'HUSK', 'ICON', 'JADE',
  'KNOX', 'LOOM', 'MOTH', 'NULL', 'OPAL', 'PYRE', 'QUO', 'REX',
  'ARC', 'BLITZ', 'CRUX', 'DASH', 'EDGE', 'FERN', 'GALE', 'HYDRA',
  'IBEX', 'JEST', 'KRAKEN', 'LURE', 'MEND', 'NYX', 'OATH', 'PLUME',
  'QUILT', 'ROOK', 'SHARD', 'THORN', 'URSA', 'VEX', 'WICK', 'XERO',
  'YARN', 'ZEAL', 'ASPEN', 'BRAVO', 'CREST', 'DUNE', 'FOXX', 'GRAVE',
  'HOLLOW', 'ION', 'JIVE', 'KARMA', 'LOTUS', 'MYTH', 'NADIR', 'ODIN',
  'PROWL', 'QUIVER', 'RALLY', 'SAGE', 'TIDE', 'VYNE', 'WANE', 'ZORRO',
];
