/**
 * Broadcast / SMS body merge fields: `{{firstName}}` and `$FIRST_NAME` (and
 * `$BUSINESS` for company). CSV columns are stored under header names and
 * canonical import field names so either syntax resolves.
 */

const canonicalize = (header: string): string =>
  String(header || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Normalized token → canonical key on mergeData (from contact import fields). */
const TOKEN_ALIASES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const add = (field: string, aliases: string[]) => {
    map[canonicalize(field)] = field;
    for (const alias of aliases) map[canonicalize(alias)] = field;
  };
  add('firstName', ['firstname', 'fname', 'first', 'givenname', 'first_name']);
  add('lastName', ['lastname', 'lname', 'last', 'surname', 'familyname', 'last_name']);
  add('emailAddress', ['email', 'emailaddress', 'mail', 'email_address']);
  add('company', ['company', 'business', 'businessname', 'business_name', 'organization', 'dba', 'merchant']);
  add('street', ['street', 'address', 'address1', 'streetaddress', 'address_line_1']);
  add('city', ['city', 'town']);
  add('state', ['state', 'province', 'region']);
  add('zip', ['zip', 'zipcode', 'postalcode', 'postcode']);
  return map;
})();

const BRACE_TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;
const DOLLAR_TOKEN = /\$([A-Za-z][A-Za-z0-9_]*)/g;

export function lookupMergeValue(mergeData: Record<string, unknown>, token: string): string | undefined {
  const direct = mergeData[token];
  if (direct !== null && direct !== undefined && String(direct).trim() !== '') {
    return String(direct);
  }

  const canonToken = canonicalize(token);
  for (const [key, value] of Object.entries(mergeData)) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    if (canonicalize(key) === canonToken) return String(value);
  }

  const field = TOKEN_ALIASES[canonToken];
  if (field) {
    const aliased = mergeData[field];
    if (aliased !== null && aliased !== undefined && String(aliased).trim() !== '') {
      return String(aliased);
    }
  }

  return undefined;
}

/**
 * Substitute merge fields. Unknown tokens become empty so literals are not sent.
 */
export function renderTemplate(body: string, mergeData?: Record<string, unknown> | null): string {
  const resolve = (token: string) => {
    if (!mergeData) return '';
    const value = lookupMergeValue(mergeData, token);
    return value === undefined ? '' : value;
  };

  return body
    .replace(BRACE_TOKEN, (_match, token: string) => resolve(token))
    .replace(DOLLAR_TOKEN, (_match, token: string) => resolve(token));
}

/**
 * Build per-recipient merge data from a spreadsheet row. Includes every column
 * (by header) plus canonical field names from column mapping.
 */
export function buildMergeDataFromSheetRow(
  row: Record<string, unknown>,
  columnMapping: Record<string, string>,
  phoneHeader: string,
): Record<string, unknown> {
  const mergeData: Record<string, unknown> = {};

  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    mergeData[key] = value;
  };

  for (const [header, value] of Object.entries(row)) {
    if (header === phoneHeader) continue;
    set(header, value);
  }

  for (const [header, field] of Object.entries(columnMapping)) {
    if (field === 'phoneNumber') continue;
    set(field, row[header]);
  }

  return mergeData;
}
