// Player IDENTITY — the person behind the gamertag (DESIGN §4). Every player has a real
// NAME and a BIRTHDAY derived deterministically from their id (an FNV hash, like traitOf /
// mapAffinity), so there's NO Player contract change and NO world-stream impact — the engine
// never sees it, so seed 42 is byte-identical. The handle (gamertag) stays the competitive
// identity; this is the human under it, and the birthday reads against the in-game calendar
// so a player visibly turns a year older on their day.
import type { GameDate } from './calendar.js';
import { birthdayPassed } from './calendar.js';

// esports is global — a spread of the scenes that produce Valorant pros, each with its
// OWN name pools so the name reads coherent with the flag (a 🇰🇷 player has a Korean name,
// not a random international draw). Pools are first/last drawn independently within a nation.
interface Nation { country: string; flag: string; first: string[]; last: string[] }
const NATIONS: Nation[] = [
  { country: 'USA', flag: '🇺🇸',
    first: ['Tyler', 'Ethan', 'Jordan', 'Mason', 'Caleb', 'Logan', 'Brandon', 'Aaron', 'Devon', 'Trent'],
    last: ['Carter', 'Reyes', 'Brooks', 'Hayes', 'Parker', 'Mitchell', 'Foster', 'Coleman', 'Pierce', 'Walsh'] },
  { country: 'Korea', flag: '🇰🇷',
    first: ['Dae-hyun', 'Sung-min', 'Joon-ho', 'Min-jae', 'Ji-hoon', 'Seung-woo', 'Hyun-woo', 'Jae-won', 'Tae-yang', 'Do-yoon'],
    last: ['Park', 'Kim', 'Lee', 'Choi', 'Jung', 'Kang', 'Yoon', 'Han', 'Seo', 'Oh'] },
  { country: 'Brazil', flag: '🇧🇷',
    first: ['Lucas', 'Mateus', 'Gabriel', 'Rafael', 'Felipe', 'Bruno', 'Thiago', 'Andre', 'Renato', 'Caio'],
    last: ['Silva', 'Costa', 'Santos', 'Ferreira', 'Oliveira', 'Souza', 'Rocha', 'Almeida', 'Pereira', 'Lima'] },
  { country: 'Sweden', flag: '🇸🇪',
    first: ['Erik', 'Anders', 'Sven', 'Oscar', 'Gustav', 'Emil', 'Viktor', 'Albin', 'Hampus', 'Linus'],
    last: ['Berg', 'Lindqvist', 'Larsson', 'Nilsson', 'Eklund', 'Holm', 'Sandberg', 'Forsberg', 'Lund', 'Ahlberg'] },
  { country: 'Japan', flag: '🇯🇵',
    first: ['Hiroshi', 'Yuki', 'Kenji', 'Sora', 'Ren', 'Haruto', 'Riku', 'Takumi', 'Daiki', 'Kaito'],
    last: ['Nakamura', 'Mori', 'Sato', 'Tanaka', 'Yamamoto', 'Kobayashi', 'Ito', 'Watanabe', 'Suzuki', 'Takahashi'] },
  { country: 'Germany', flag: '🇩🇪',
    first: ['Felix', 'Kai', 'Jonas', 'Niklas', 'Lukas', 'Maximilian', 'Tim', 'Leon', 'Florian', 'Moritz'],
    last: ['Becker', 'Schmidt', 'Wagner', 'Müller', 'Fischer', 'Weber', 'Hoffmann', 'Schulz', 'Bauer', 'Richter'] },
  { country: 'France', flag: '🇫🇷',
    first: ['Théo', 'Lucas', 'Hugo', 'Nathan', 'Enzo', 'Antoine', 'Mathis', 'Clément', 'Adrien', 'Baptiste'],
    last: ['Dubois', 'Moreau', 'Laurent', 'Lefebvre', 'Girard', 'Bernard', 'Rousseau', 'Fontaine', 'Mercier', 'Henry'] },
  { country: 'United Kingdom', flag: '🇬🇧',
    first: ['Owen', 'Liam', 'Harry', 'Jack', 'Callum', 'Oliver', 'George', 'Charlie', 'Finn', 'Reece'],
    last: ['Halls', 'Walsh', 'Murphy', 'Hughes', 'Wright', 'Clarke', 'Hudson', 'Reid', 'Barker', 'Shaw'] },
  { country: 'China', flag: '🇨🇳',
    first: ['Wei', 'Hao', 'Jian', 'Yang', 'Lei', 'Feng', 'Chen', 'Bo', 'Kun', 'Tao'],
    last: ['Tan', 'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu'] },
  { country: 'Türkiye', flag: '🇹🇷',
    first: ['Mehmet', 'Emir', 'Kaan', 'Arda', 'Burak', 'Cem', 'Deniz', 'Efe', 'Mert', 'Yusuf'],
    last: ['Yılmaz', 'Öztürk', 'Demir', 'Kaya', 'Şahin', 'Çelik', 'Aydın', 'Arslan', 'Doğan', 'Koç'] },
  { country: 'Canada', flag: '🇨🇦',
    first: ['Noah', 'Liam', 'Cole', 'Nathan', 'Tyler', 'Riley', 'Aiden', 'Hunter', 'Dawson', 'Carson'],
    last: ['Tremblay', 'Roy', 'Gagnon', 'Wilson', 'MacDonald', 'Bouchard', 'Côté', 'Reid', 'Fortin', 'Bennett'] },
  { country: 'Spain', flag: '🇪🇸',
    first: ['Pablo', 'Diego', 'Carlos', 'Álvaro', 'Sergio', 'Javier', 'Marcos', 'Adrián', 'Rubén', 'Iván'],
    last: ['Vásquez', 'Reyes', 'García', 'Martínez', 'López', 'Sánchez', 'Romero', 'Navarro', 'Torres', 'Gil'] },
  { country: 'Denmark', flag: '🇩🇰',
    first: ['Mikkel', 'Anders', 'Frederik', 'Lasse', 'Magnus', 'Kasper', 'Emil', 'Oliver', 'Mads', 'Rasmus'],
    last: ['Andersen', 'Nielsen', 'Sørensen', 'Jensen', 'Pedersen', 'Christensen', 'Larsen', 'Hansen', 'Møller', 'Holm'] },
  { country: 'Poland', flag: '🇵🇱',
    first: ['Jakub', 'Marek', 'Tomasz', 'Bartosz', 'Kamil', 'Wojciech', 'Mateusz', 'Filip', 'Szymon', 'Paweł'],
    last: ['Kowalski', 'Nowak', 'Wiśniewski', 'Wójcik', 'Kamiński', 'Lewandowski', 'Zieliński', 'Szymański', 'Woźniak', 'Kozłowski'] },
  { country: 'Finland', flag: '🇫🇮',
    first: ['Niko', 'Eetu', 'Onni', 'Aleksi', 'Joona', 'Veeti', 'Leevi', 'Elias', 'Miro', 'Rasmus'],
    last: ['Virtanen', 'Korhonen', 'Mäkinen', 'Nieminen', 'Heikkinen', 'Laine', 'Koskinen', 'Järvinen', 'Lehtonen', 'Salminen'] },
  { country: 'Australia', flag: '🇦🇺',
    first: ['Liam', 'Jack', 'Cooper', 'Mason', 'Hayden', 'Lachlan', 'Bailey', 'Jett', 'Riley', 'Kai'],
    last: ['Walsh', 'Murphy', 'Thompson', 'Reid', 'Mitchell', 'Bennett', 'Carter', 'Hayes', 'Ryan', 'Foster'] },
  { country: 'Indonesia', flag: '🇮🇩',
    first: ['Adi', 'Bagus', 'Dimas', 'Rizki', 'Eko', 'Putra', 'Fajar', 'Yoga', 'Bayu', 'Reza'],
    last: ['Wijaya', 'Santoso', 'Pratama', 'Halim', 'Saputra', 'Kusuma', 'Gunawan', 'Hidayat', 'Nugroho', 'Lestari'] },
  { country: 'Mexico', flag: '🇲🇽',
    first: ['Carlos', 'Diego', 'Luis', 'Emilio', 'Santiago', 'Ángel', 'Mateo', 'Iker', 'Rodrigo', 'Cristian'],
    last: ['Reyes', 'Hernández', 'García', 'Ramírez', 'Flores', 'Vásquez', 'Morales', 'Castillo', 'Mendoza', 'Ortiz'] },
];
// 3-letter country codes (national-team tags for the World Cup)
const CODE: Record<string, string> = {
  USA: 'USA', Korea: 'KOR', Brazil: 'BRA', Sweden: 'SWE', Japan: 'JPN', Germany: 'GER',
  France: 'FRA', 'United Kingdom': 'GBR', China: 'CHN', 'Türkiye': 'TUR', Canada: 'CAN',
  Spain: 'ESP', Denmark: 'DEN', Poland: 'POL', Finland: 'FIN', Australia: 'AUS', Indonesia: 'IDN', Mexico: 'MEX',
};
export interface Person { first: string; last: string; name: string; birthday: { month: number; day: number }; nation: { country: string; flag: string; code: string } }

/** A 32-bit FNV-1a hash of an id with an optional salt — deterministic, no rng. */
function h32(id: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** The person behind a player id — real name + birthday, derived (no rng, no contract change).
 *  Nation is chosen first, then the name is drawn from THAT nation's pools, so the name reads
 *  coherent with the flag (a 🇰🇷 player is "Min-jae Park", not a random international mix). */
export function personOf(id: string): Person {
  const nation = NATIONS[h32(id, 0x6b) % NATIONS.length];
  const first = nation.first[h32(id, 0x1f) % nation.first.length];
  const last = nation.last[h32(id, 0x2c) % nation.last.length];
  const doy = h32(id, 0x9d) % 365;                 // birthday as a day-of-year → month/day
  const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let d = doy + 1, m = 0;
  while (d > MONTHS[m]) { d -= MONTHS[m]; m++; }
  return { first, last, name: `${first} ${last}`, birthday: { month: m + 1, day: d }, nation: { country: nation.country, flag: nation.flag, code: CODE[nation.country] ?? nation.country.slice(0, 3).toUpperCase() } };
}

/** The age to SHOW: the engine's integer age is "age at the season's start"; the player
 *  turns a year older on their birthday, so once it's passed this season they read +1.
 *  (Development still uses the integer age — this is the player-facing number.) */
export const displayAge = (age: number, birthday: { month: number; day: number }, today: GameDate): number =>
  age + (birthdayPassed(birthday, today) ? 1 : 0);
