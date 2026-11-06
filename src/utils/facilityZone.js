// The wall clock a contract's block times are on: where the facility is, not
// where this device is. A Pacific phone saving a Fargo, ND agreement stamped
// its 6:00 AM turnover on Pacific time, so a 7:00 AM Central procedure was
// filed under the day before (owner's ticket, 2026-11-06).
//
// facilityZone({ workState, location }) reads the state from the Work state,
// else from the ", ST" (or ", State") tail of the Location, and returns
//   { zone, state, sure }
// zone   one of the Contracts form's zones (US_ZONES), or "" when no state is
//        given. A state split between two zones gives the zone of the city
//        when the city is known, else the zone most of the state keeps time in.
// sure   false for that last case: the form names the zone and asks the
//        physician to check it, and never warns or confirms on a guess.
// Only the zones the form offers are returned (America/Boise keeps Mountain
// time, America/Detroit and America/Indiana/* keep Eastern), so the select
// shows the zone by name.
import { canonicalState } from "./snapOption.js";

const ET = "America/New_York", CT = "America/Chicago", MT = "America/Denver", AZ = "America/Phoenix",
  PT = "America/Los_Angeles", AKT = "America/Anchorage", HT = "Pacific/Honolulu", AST = "America/Puerto_Rico", CHT = "Pacific/Guam";

const ONE_ZONE = Object.freeze({
  AL: CT, AR: CT, IA: CT, IL: CT, LA: CT, MN: CT, MO: CT, MS: CT, OK: CT, WI: CT,
  CT: ET, DC: ET, DE: ET, GA: ET, MA: ET, MD: ET, ME: ET, NC: ET, NH: ET, NJ: ET, NY: ET, OH: ET,
  PA: ET, RI: ET, SC: ET, VA: ET, VT: ET, WV: ET,
  CO: MT, MT: MT, NM: MT, UT: MT, WY: MT,
  CA: PT, WA: PT, HI: HT,
  PR: AST, VI: AST, GU: CHT, MP: CHT,
});

// A split state: the zone most of it keeps, and its cities by zone (lower
// case). Facility towns, not every town: an unlisted city is not "sure".
const SPLIT = Object.freeze({
  ND: { most: CT, cities: {
    [CT]: ["fargo", "bismarck", "mandan", "grand forks", "minot", "jamestown", "williston", "devils lake", "valley city", "wahpeton", "west fargo", "rugby", "grafton"],
    [MT]: ["dickinson", "bowman", "hettinger", "beach", "new england", "mott", "belfield"] } },
  SD: { most: CT, cities: {
    [CT]: ["sioux falls", "aberdeen", "brookings", "watertown", "mitchell", "pierre", "huron", "yankton", "vermillion", "madison", "chamberlain", "mobridge"],
    [MT]: ["rapid city", "spearfish", "sturgis", "belle fourche", "hot springs", "custer", "lead", "deadwood", "philip", "lemmon"] } },
  NE: { most: CT, cities: {
    [CT]: ["omaha", "lincoln", "grand island", "kearney", "hastings", "norfolk", "columbus", "fremont", "north platte", "mccook", "york", "beatrice", "bellevue", "papillion"],
    [MT]: ["scottsbluff", "gering", "alliance", "sidney", "chadron", "ogallala", "kimball"] } },
  KS: { most: CT, cities: {
    [CT]: ["wichita", "topeka", "kansas city", "overland park", "olathe", "lawrence", "manhattan", "salina", "hutchinson", "hays", "dodge city", "garden city", "liberal", "emporia", "pittsburg", "great bend", "colby"],
    [MT]: ["goodland", "tribune", "syracuse", "sharon springs"] } },
  TX: { most: CT, cities: {
    [CT]: ["houston", "dallas", "san antonio", "austin", "fort worth", "lubbock", "amarillo", "midland", "odessa", "corpus christi", "waco", "tyler", "abilene", "laredo", "mcallen", "brownsville", "beaumont", "temple", "killeen", "san angelo", "wichita falls", "longview", "plano", "harlingen", "edinburg", "bryan", "college station", "victoria", "big spring", "alpine", "fort stockton", "pecos"],
    [MT]: ["el paso", "van horn", "dell city", "sierra blanca", "fabens", "horizon city", "socorro", "canutillo", "anthony"] } },
  FL: { most: ET, cities: {
    [ET]: ["miami", "orlando", "tampa", "jacksonville", "tallahassee", "gainesville", "fort lauderdale", "west palm beach", "st petersburg", "sarasota", "fort myers", "naples", "ocala", "daytona beach", "lakeland", "melbourne", "port st lucie"],
    [CT]: ["pensacola", "panama city", "panama city beach", "santa rosa beach", "gulf breeze", "navarre", "fort walton beach", "destin", "crestview", "niceville", "marianna", "milton", "defuniak springs", "chipley"] } },
  ID: { most: MT, cities: {
    [MT]: ["boise", "nampa", "meridian", "idaho falls", "pocatello", "twin falls", "caldwell", "rexburg", "blackfoot", "burley", "mountain home", "jerome", "salmon", "mccall"],
    [PT]: ["coeur d'alene", "coeur dalene", "moscow", "lewiston", "sandpoint", "post falls", "orofino", "grangeville", "bonners ferry", "kellogg"] } },
  IN: { most: ET, cities: {
    [ET]: ["indianapolis", "fort wayne", "south bend", "bloomington", "lafayette", "muncie", "terre haute", "anderson", "kokomo", "richmond", "columbus", "elkhart", "carmel", "fishers", "mishawaka"],
    [CT]: ["gary", "evansville", "hammond", "valparaiso", "merrillville", "michigan city", "la porte", "laporte", "crown point", "munster", "east chicago", "mount vernon", "tell city"] } },
  KY: { most: ET, cities: {
    [ET]: ["louisville", "lexington", "frankfort", "covington", "richmond", "pikeville", "ashland", "somerset", "london", "hazard", "corbin", "elizabethtown", "danville", "florence", "morehead"],
    [CT]: ["bowling green", "paducah", "owensboro", "hopkinsville", "madisonville", "murray", "henderson", "mayfield", "glasgow", "russellville", "princeton"] } },
  TN: { most: CT, cities: {
    [CT]: ["nashville", "memphis", "clarksville", "murfreesboro", "jackson", "franklin", "columbia", "cookeville", "tullahoma", "dyersburg", "union city", "paris", "lebanon", "gallatin"],
    [ET]: ["knoxville", "chattanooga", "johnson city", "kingsport", "bristol", "oak ridge", "cleveland", "morristown", "maryville", "athens", "greeneville"] } },
  MI: { most: ET, cities: {
    [ET]: ["detroit", "grand rapids", "lansing", "ann arbor", "flint", "kalamazoo", "traverse city", "saginaw", "marquette", "sault ste marie", "petoskey", "royal oak", "southfield", "escanaba"],
    [CT]: ["iron mountain", "menominee", "ironwood", "kingsford", "iron river"] } },
  OR: { most: PT, cities: {
    [PT]: ["portland", "eugene", "salem", "medford", "bend", "corvallis", "pendleton", "klamath falls", "roseburg", "grants pass", "the dalles", "coos bay", "hermiston", "baker city", "la grande"],
    [MT]: ["ontario", "nyssa", "vale"] } },
  NV: { most: PT, cities: {
    [PT]: ["las vegas", "reno", "henderson", "carson city", "sparks", "elko", "fallon", "winnemucca", "ely", "pahrump", "mesquite"],
    [MT]: ["west wendover", "jackpot"] } },
  // The Navajo Nation keeps Mountain daylight time; the rest of Arizona, the
  // Hopi towns included, keeps Arizona time all year.
  AZ: { most: AZ, cities: {
    [AZ]: ["phoenix", "tucson", "mesa", "scottsdale", "tempe", "chandler", "gilbert", "glendale", "flagstaff", "yuma", "prescott", "sierra vista", "lake havasu city", "kingman", "bullhead city", "show low", "payson", "casa grande", "nogales", "page", "winslow", "holbrook", "keams canyon", "polacca", "safford", "douglas", "cottonwood", "sedona", "peoria", "surprise", "goodyear"],
    [MT]: ["chinle", "tuba city", "fort defiance", "window rock", "kayenta", "ganado", "many farms", "shonto", "kaibeto", "dilkon"] } },
  AK: { most: AKT, cities: {
    [AKT]: ["anchorage", "fairbanks", "juneau", "sitka", "ketchikan", "bethel", "kodiak", "nome", "soldotna", "wasilla", "palmer", "kenai", "homer", "barrow", "utqiagvik"] } },
});

// Lower case, no dots, curly apostrophes straight, and the usual short forms
// spelled out: "Ft. Walton Beach" -> "fort walton beach", "Mt. Vernon" ->
// "mount vernon", "Saint Petersburg" -> "st petersburg".
const WORDS = { ft: "fort", mt: "mount", pt: "port", saint: "st" };
const fold = (s) => String(s || "").toLowerCase().replace(/[\u2019`]/g, "'").replace(/\./g, " ").replace(/[^a-z0-9' ]+/g, " ")
  .split(" ").filter(Boolean).map((w) => WORDS[w] || w).join(" ");

// A trailing country or note is no part of the place: "Fargo, ND 58122, USA",
// "Fargo, ND (main campus)".
const COUNTRY = /(?:,|\s)\s*(?:u\.?\s?s\.?\s?a?\.?|united states(?: of america)?)\s*$/i;
function clean(location) {
  let text = String(location || "").replace(/\([^)]*\)/g, " ").replace(/\b\d{5}(?:-\d{4})?\b/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) text = text.replace(/[\s,]+$/, "").replace(COUNTRY, "");
  return text.replace(/[\s,]+$/, "");
}

// -> { city, state, marked }. The state is the last comma part that names one
// (whole, or its last word or two: "Fargo ND 58122"), the city text is
// everything before it. Otherwise a last word or two that is a state code
// written in capitals ("ND") or a full name counts, but `marked` is false: a
// bare "Washington" is as often the DC or Pennsylvania town, and "Main OR"
// an operating room.
function parseLocation(location) {
  const text = clean(location);
  if (!text) return { city: "", state: null, marked: false };
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const whole = canonicalState(parts[i]);
    if (whole) return { city: fold(parts.slice(0, i).join(" ")), state: whole, marked: true };
  }
  const words = parts.join(" ").split(" ").filter(Boolean);
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const tail = words.slice(-n).join(" ");
    // A two letter word counts only as written in capitals ("ND", not "or").
    if (n === 1 && !/^[A-Z]{2}$/.test(tail) && !/^[A-Za-z]{3,}$/.test(tail)) continue;
    if (n === 1 && /^[a-z]{2}$/i.test(tail) && tail !== tail.toUpperCase()) continue;
    const state = canonicalState(tail);
    if (state) return { city: fold(words.slice(0, -n).join(" ")), state, marked: false };
  }
  return { city: "", state: null, marked: false };
}

// The listed city named in the city text, on word boundaries, the longest
// one first ("panama city beach" before "panama city"): "CHI St Alexius
// Health Dickinson" names Dickinson. Two zones named: no answer.
function cityZone(split, city) {
  if (!city) return "";
  const padded = ` ${city} `;
  let best = { len: 0, zones: new Set() };
  for (const [zone, cities] of Object.entries(split.cities)) {
    for (const name of cities) {
      if (!padded.includes(` ${name} `)) continue;
      if (name.length > best.len) best = { len: name.length, zones: new Set([zone]) };
      else if (name.length === best.len) best.zones.add(zone);
    }
  }
  return best.zones.size === 1 ? [...best.zones][0] : "";
}

export function facilityZone({ workState, location } = {}) {
  const parsed = parseLocation(location);
  const chosen = canonicalState(typeof workState === "string" ? workState : "");
  const state = chosen || parsed.state;
  if (!state) return { zone: "", state: null, sure: false };
  // A state read only from loose words ("Washington") is a guess.
  const sure = Boolean(chosen) || parsed.marked;
  if (ONE_ZONE[state]) return { zone: ONE_ZONE[state], state, sure };
  const split = SPLIT[state];
  if (!split) return { zone: "", state, sure: false };
  // A city from the Location counts only when it is in the Work state.
  const zone = parsed.state === state ? cityZone(split, parsed.city) : "";
  if (zone) return { zone, state, sure };
  return { zone: split.most, state, sure: false };
}

// Two zones keep the same clock when their offsets agree in winter and in
// summer (America/Boise and America/Denver, America/Detroit and New York).
const OFFSETS = new Map();
const offsets = (zone) => {
  if (OFFSETS.has(zone)) return OFFSETS.get(zone);
  let out = "";
  try {
    out = ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z"].map((at) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value).join("|");
  } catch { out = ""; }
  OFFSETS.set(zone, out);
  return out;
};
export const sameClock = (a, b) => a === b || (Boolean(a) && Boolean(b) && offsets(a) !== "" && offsets(a) === offsets(b));

// The name the form shows for a zone ("Central"), or "" for one it does not offer.
export const ZONE_NAMES = Object.freeze({ [ET]: "Eastern", [CT]: "Central", [MT]: "Mountain", [AZ]: "Arizona", [PT]: "Pacific", [AKT]: "Alaska", [HT]: "Hawaii", [AST]: "Atlantic", [CHT]: "Chamorro" });
