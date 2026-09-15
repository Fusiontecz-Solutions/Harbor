/** US state tokens that should match each other for funder allowed-state checks. */
const STATE_ALIAS_GROUPS: string[][] = [
  ['alabama', 'al'],
  ['alaska', 'ak'],
  ['arizona', 'az'],
  ['arkansas', 'ar'],
  ['california', 'ca'],
  ['colorado', 'co'],
  ['connecticut', 'ct'],
  ['delaware', 'de'],
  ['florida', 'fl'],
  ['georgia', 'ga'],
  ['hawaii', 'hi'],
  ['idaho', 'id'],
  ['illinois', 'il'],
  ['indiana', 'in'],
  ['iowa', 'ia'],
  ['kansas', 'ks'],
  ['kentucky', 'ky'],
  ['louisiana', 'la'],
  ['maine', 'me'],
  ['maryland', 'md'],
  ['massachusetts', 'ma'],
  ['michigan', 'mi'],
  ['minnesota', 'mn'],
  ['mississippi', 'ms'],
  ['missouri', 'mo'],
  ['montana', 'mt'],
  ['nebraska', 'ne'],
  ['nevada', 'nv'],
  ['new hampshire', 'nh'],
  ['new jersey', 'nj'],
  ['new mexico', 'nm'],
  ['new york', 'ny', 'newyork', 'new_york'],
  ['north carolina', 'nc'],
  ['north dakota', 'nd'],
  ['ohio', 'oh'],
  ['oklahoma', 'ok'],
  ['oregon', 'or'],
  ['pennsylvania', 'pa'],
  ['rhode island', 'ri'],
  ['south carolina', 'sc'],
  ['south dakota', 'sd'],
  ['tennessee', 'tn'],
  ['texas', 'tx'],
  ['utah', 'ut'],
  ['vermont', 'vt'],
  ['virginia', 'va'],
  ['washington', 'wa'],
  ['west virginia', 'wv'],
  ['wisconsin', 'wi'],
  ['wyoming', 'wy'],
  ['district of columbia', 'dc'],
];

const CANONICAL_STATE = new Map<string, string>();
for (const group of STATE_ALIAS_GROUPS) {
  const canonical = group[0];
  for (const token of group) {
    CANONICAL_STATE.set(token, canonical);
  }
}

export function normalizeContractStateToken(state?: string | null): string {
  const raw = String(state ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
  if (!raw) return '';
  return CANONICAL_STATE.get(raw) || raw;
}

/** True when the whole string is a US state name or abbreviation (e.g. "Connecticut" / "CT"). */
export function isKnownUsStateToken(state?: string | null): boolean {
  const raw = String(state ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
  return Boolean(raw) && CANONICAL_STATE.has(raw);
}

/** Two-letter USPS code for ST fields (e.g. "Connecticut" → "CT"). */
export function toUsStateAbbreviation(state?: string | null): string {
  const raw = String(state ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
  if (!raw) return '';
  for (const group of STATE_ALIAS_GROUPS) {
    if (!group.includes(raw)) continue;
    const abbr = group.find((token) => token.length === 2);
    return abbr ? abbr.toUpperCase() : String(state ?? '').trim();
  }
  if (/^[a-z]{2}$/.test(raw)) return raw.toUpperCase();
  return String(state ?? '').trim();
}

const ADDRESS_PLACEHOLDER_TOKENS = new Set([
  'usa',
  'us',
  'u s',
  'u s a',
  'united states',
  'united states of america',
  'america',
  'n/a',
  'na',
  'none',
  'unknown',
  'tbd',
  'null',
]);

function normalizeAddressToken(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

/** Country / state / ZIP / placeholder — not a street line. */
export function isAddressPlaceholderToken(value?: string | null): boolean {
  const raw = normalizeAddressToken(value);
  if (!raw) return true;
  if (ADDRESS_PLACEHOLDER_TOKENS.has(raw)) return true;
  if (isKnownUsStateToken(raw)) return true;
  if (/^\d{5}(-\d{4})?$/.test(raw)) return true;
  return false;
}

/** True when the string can be used as a disclosure street (not USA / CT / ZIP alone). */
export function isUsableDisclosureStreetLine(value?: string | null): boolean {
  const s = String(value ?? '').trim();
  if (!s) return false;
  const parts = s
    .split(/[,|/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.every((p) => isAddressPlaceholderToken(p))) return false;
  return true;
}

export function contractStatesMatch(
  left?: string | null,
  right?: string | null,
): boolean {
  const a = normalizeContractStateToken(left);
  const b = normalizeContractStateToken(right);
  if (!a || !b) return false;
  return a === b;
}

export function isTexasContractState(state?: string | null): boolean {
  return normalizeContractStateToken(state) === 'texas';
}

export function funderStateListIncludes(
  allowedOrExcluded: string[] | null | undefined,
  state?: string | null,
): boolean {
  const target = normalizeContractStateToken(state);
  if (!target) return false;
  for (const raw of allowedOrExcluded ?? []) {
    if (contractStatesMatch(raw, target)) return true;
  }
  return false;
}
