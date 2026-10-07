/**
 * U.S. SMS segment counting — GSM-7 vs UCS-2. Keep in sync with harbor-be `smsSegments.ts`.
 */

export type SmsEncoding = 'gsm-7' | 'ucs-2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  encodingLabel: string;
  characters: number;
  segments: number;
  credits: number;
  isUnicode: boolean;
  unicodeTriggers: string[];
}

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

const GSM_BASIC_SET = new Set(GSM_BASIC.split(''));
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED.split(''));

const GSM_SINGLE = 160;
const GSM_MULTI = 153;
const UCS_SINGLE = 70;
const UCS_MULTI = 67;

const LATIN_ASCII: Record<string, string> = {
  Ã: 'A',
  ã: 'a',
  Á: 'A',
  á: 'a',
  Â: 'A',
  â: 'a',
  À: 'A',
  à: 'a',
  Ä: 'A',
  ä: 'a',
  Å: 'A',
  å: 'a',
  Æ: 'AE',
  æ: 'ae',
  Ç: 'C',
  ç: 'c',
  Ð: 'D',
  ð: 'd',
  É: 'E',
  é: 'e',
  È: 'E',
  è: 'e',
  Ê: 'E',
  ê: 'e',
  Ë: 'E',
  ë: 'e',
  Í: 'I',
  í: 'i',
  Ì: 'I',
  ì: 'i',
  Î: 'I',
  î: 'i',
  Ï: 'I',
  ï: 'i',
  Ñ: 'N',
  ñ: 'n',
  Ó: 'O',
  ó: 'o',
  Ò: 'O',
  ò: 'o',
  Ô: 'O',
  ô: 'o',
  Ö: 'O',
  ö: 'o',
  Ø: 'O',
  ø: 'o',
  Œ: 'OE',
  œ: 'oe',
  Ú: 'U',
  ú: 'u',
  Ù: 'U',
  ù: 'u',
  Û: 'U',
  û: 'u',
  Ü: 'U',
  ü: 'u',
  Ý: 'Y',
  ý: 'y',
  Ÿ: 'Y',
  ÿ: 'y',
  ß: 'ss',
  Þ: 'Th',
  þ: 'th',
};

function isGsmChar(char: string): boolean {
  return GSM_BASIC_SET.has(char) || GSM_EXTENDED_SET.has(char);
}

function gsmSeptets(text: string): number | null {
  let septets = 0;
  for (const char of text) {
    if (GSM_EXTENDED_SET.has(char)) septets += 2;
    else if (GSM_BASIC_SET.has(char)) septets += 1;
    else return null;
  }
  return septets;
}

function segmentsForGsm(septets: number): number {
  if (septets <= GSM_SINGLE) return 1;
  return Math.ceil(septets / GSM_MULTI);
}

function segmentsForUcs(units: number): number {
  if (units <= UCS_SINGLE) return 1;
  return Math.ceil(units / UCS_MULTI);
}

function unicodeTriggers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of text) {
    if (isGsmChar(char)) continue;
    if (!seen.has(char)) {
      seen.add(char);
      out.push(char);
    }
  }
  return out;
}

export function analyzeSmsText(text: string): SmsSegmentInfo {
  const gsmLen = gsmSeptets(text);
  if (gsmLen !== null) {
    const segments = segmentsForGsm(gsmLen);
    return {
      encoding: 'gsm-7',
      encodingLabel: 'GSM-7',
      characters: gsmLen,
      segments,
      credits: segments,
      isUnicode: false,
      unicodeTriggers: [],
    };
  }

  const units = text.length;
  const segments = segmentsForUcs(units);
  return {
    encoding: 'ucs-2',
    encodingLabel: 'Unicode / UCS-2',
    characters: units,
    segments,
    credits: segments,
    isUnicode: true,
    unicodeTriggers: unicodeTriggers(text),
  };
}

function mapCharToGsm(char: string): string {
  if (isGsmChar(char)) return char;

  const mapped = LATIN_ASCII[char];
  if (mapped) return mapped;

  const stripped = char.normalize('NFD').replace(/\p{M}/gu, '');
  if (stripped !== char && isGsmChar(stripped)) return stripped;
  if (stripped !== char && LATIN_ASCII[stripped]) return LATIN_ASCII[stripped];

  if (/[\p{Extended_Pictographic}\p{Emoji}]/u.test(char)) return '';

  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return char;

  return '';
}

export function convertToSmsSafeText(text: string): string {
  let out = text
    .normalize('NFKC')
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2022\u2023\u2043\u2219]/g, '-')
    .replace(/\u00B7/g, '.')
    .replace(/\u2122/g, 'TM')
    .replace(/\u00AE/g, '(R)')
    .replace(/\u00A9/g, '(c)')
    .replace(/\u00BC/g, '1/4')
    .replace(/\u00BD/g, '1/2')
    .replace(/\u00BE/g, '3/4')
    .replace(/\u00D7/g, 'x')
    .replace(/\u00F7/g, '/');

  out = [...out].map(mapCharToGsm).join('');
  out = out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

  return out;
}

export function canConvertToSmsSafeText(text: string): boolean {
  const converted = convertToSmsSafeText(text);
  if (converted !== text) return true;
  return analyzeSmsText(text).isUnicode;
}

export function estimatedCampaignCredits(recipients: number, segmentsPerRecipient: number): number {
  if (!Number.isFinite(recipients) || recipients < 0) return 0;
  return recipients * Math.max(1, segmentsPerRecipient);
}
