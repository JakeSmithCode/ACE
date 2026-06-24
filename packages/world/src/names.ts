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

/** Player handles — the in-game names. A big pool so a 20-club, two-division
 *  league (100 players) draws without replacement AND leaves a disjoint pool for
 *  free agents, with headroom for transfer churn — every handle stays unique. */
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
