/**
 * U.S. SMS segment counting — GSM-7 vs UCS-2, single and multipart limits.
 * Keep harbor-fe and dms copies in sync with this module.
 */
import { renderTemplate } from './mergeTemplate';

export type SmsEncoding = 'gsm-7' | 'ucs-2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** Human label for UI, e.g. GSM-7 or Unicode / UCS-2 */
  encodingLabel: string;
  /** Septets (GSM-7) or UTF-16 code units (UCS-2) */
  characters: number;
  segments: number;
  /** Billable SMS parts — one credit per segment per recipient */
  credits: number;
  isUnicode: boolean;
  /** Distinct characters that forced UCS-2 (for warnings) */
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

function gsmSeptets(text: string): number | null {
  let septets = 0;
  for (const char of text) {
    if (GSM_EXTENDED_SET.has(char)) septets += 2;
    else if (GSM_BASIC_SET.has(char)) septets += 1;
    else return null;
  }
  return septets;
}

function ucs2Units(text: string): number {
  return text.length;
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
    if (GSM_BASIC_SET.has(char) || GSM_EXTENDED_SET.has(char)) continue;
    if (!seen.has(char)) {
      seen.add(char);
      out.push(char);
    }
  }
  return out;
}

/** Analyze a final message body (after merge) for encoding and segments. */
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

  const units = ucs2Units(text);
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

/**
 * Worst-case segments when merge fields expand per recipient.
 * Scans up to `limit` merge rows (default 2_000) for performance.
 */
export function analyzeSmsTemplate(
  template: string,
  mergeDataList: Record<string, unknown>[] | null | undefined,
  limit = 2_000,
): SmsSegmentInfo {
  const samples = mergeDataList?.filter(Boolean) ?? [];
  if (samples.length === 0) return analyzeSmsText(template);

  let worst = analyzeSmsText(renderTemplate(template, samples[0]));
  const cap = Math.min(samples.length, limit);
  for (let i = 1; i < cap; i += 1) {
    const info = analyzeSmsText(renderTemplate(template, samples[i]));
    if (info.segments > worst.segments || (info.segments === worst.segments && info.characters > worst.characters)) {
      worst = info;
    }
  }
  return worst;
}

/** Replace common “smart” punctuation with GSM-7-safe ASCII. Does not strip emojis or non-Latin text. */
export function convertToSmsSafeText(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

export function estimatedCampaignCredits(recipients: number, segmentsPerRecipient: number): number {
  if (!Number.isFinite(recipients) || recipients < 0) return 0;
  return recipients * Math.max(1, segmentsPerRecipient);
}
