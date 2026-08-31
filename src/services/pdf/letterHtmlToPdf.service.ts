import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const LOG_PREFIX = '[letter-html-pdf]';

/** Puppeteer `setContent` timeout (ms) ΓÇö letters may load many external images. */
const SET_CONTENT_TIMEOUT_MS = Number(process.env.LETTER_PDF_SET_CONTENT_TIMEOUT_MS ?? '45000');

/** Max time to wait for `<img>` decode after `load` (ms). */
const IMAGE_WAIT_MS = Number(process.env.LETTER_PDF_IMAGE_WAIT_MS ?? '12000');

/** When `1`, shrink letter to fit one A4 page if it overflows (may reduce text size). */
const FIT_ONE_PAGE = process.env.LETTER_PDF_FIT_ONE_PAGE === '1';

/** Letter PDF width (mm). Default A4 width. */
const LETTER_PDF_PAGE_WIDTH_MM = (() => {
    const n = Number(process.env.LETTER_PDF_PAGE_WIDTH_MM ?? '210');
    return Number.isFinite(n) && n > 0 ? n : 210;
})();

/**
 * Optional cap used only by LETTER_PDF_FIT_ONE_PAGE scaling.
 */
const LETTER_PDF_FIT_HEIGHT_MM = (() => {
    const n = Number(process.env.LETTER_PDF_PAGE_HEIGHT_MM ?? '320');
    return Number.isFinite(n) && n > 0 ? n : 320;
})();

/** Fallback when the letter card cannot be measured (mm). */
const LETTER_PDF_MEASURE_FALLBACK_MM = 20;

/**
 * Minimum PDF page height (mm). Short letters still get a full A4 sheet instead
 * of a stubby content-cropped page. Override with LETTER_PDF_MIN_PAGE_HEIGHT_MM.
 */
const LETTER_PDF_MIN_PAGE_HEIGHT_MM = (() => {
    const n = Number(process.env.LETTER_PDF_MIN_PAGE_HEIGHT_MM ?? '297');
    return Number.isFinite(n) && n > 0 ? n : 297;
})();

/** Max single-page PDF height (mm). Very long letters may be clipped if exceeded. */
const LETTER_PDF_MAX_HEIGHT_MM = (() => {
    const n = Number(process.env.LETTER_PDF_MAX_HEIGHT_MM ?? '1500');
    return Number.isFinite(n) && n > 0 ? n : 1500;
})();

/**
 * Tiny extra page height so Chromium does not push the last footer strip onto
 * page 2. Keep well under 2mm — larger values show as a white gap under the bars.
 */
const LETTER_PDF_HEIGHT_SLACK_MM = 0.5;

/** Extra viewport px after measure so layout is not clipped before `page.pdf()`. */
const LETTER_PDF_VIEWPORT_SLACK_PX = 8;

/** Standard A4 (matches typical contract PDF pages). */
const A4_PAGE_WIDTH_MM = 210;
const A4_PAGE_HEIGHT_MM = 297;
const A4_PDF_MARGIN_TOP_MM = 12;
const A4_PDF_MARGIN_RIGHT_MM = 10;
const A4_PDF_MARGIN_BOTTOM_MM = 14;
const A4_PDF_MARGIN_LEFT_MM = 10;

function pxToMm(px: number): number {
    return (px * 25.4) / 96;
}

function mmToCssPx(mm: number): number {
    return Math.round((mm * 96) / 25.4);
}

function looksLikeFullHtmlDocument(html: string): boolean {
    const t = html.trim();
    return /^<!DOCTYPE\s+html/i.test(t) || /^<html[\s>]/i.test(t);
}

/**
 * Pull inner HTML from a full document so we can wrap it with print-safe chrome
 * (white page, no viewport grey, consistent @page).
 */
function extractBodyInnerHtml(html: string): string {
    const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (m?.[1]) return m[1].trim();
    return html.trim();
}

/**
 * Letter fragment or body inner HTML ΓåÆ full HTML document with print/PDF-only styles.
 * Chromium PDF uses this shell so the page is entirely white with no ΓÇ£browser greyΓÇ¥ frame.
 */
function buildLetterPdfDocument(innerHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style id="letter-pdf-print-shell">
  /* Page size is set from measured card height before page.pdf(); do not lock to A4. */
  @page {
    margin: 0;
    background: #ffffff;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }
  html {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: auto !important;
    min-height: 0 !important;
    background: #ffffff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  body {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: auto !important;
    min-height: 0 !important;
    background: #ffffff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
    font-family: Arial, Helvetica, sans-serif;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }

  .letter-pdf-stage {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: auto !important;
    min-height: 0 !important;
    background: #ffffff !important;
    display: block;
  }

  .letter-pdf-root {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    max-width: 100%;
    background: #ffffff !important;
    overflow: visible;
  }

  .letter-pdf-root,
  .letter-pdf-root * {
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* Outer grey email canvas: full width, no padding, no min-height (that creates blank PDF). */
  .letter-pdf-root > table,
  .letter-pdf-root > div > table {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    min-height: 0 !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    background: #ffffff !important;
    background-color: #ffffff !important;
  }
  .letter-pdf-root > table > tbody > tr > td,
  .letter-pdf-root > table > tr > td,
  .letter-pdf-root > div > table > tbody > tr > td,
  .letter-pdf-root > div > table > tr > td {
    padding: 0 !important;
    background: #ffffff !important;
    background-color: #ffffff !important;
    vertical-align: top !important;
  }

  img {
    max-width: 100%;
    height: auto;
  }

  table {
    border-collapse: collapse;
  }

  body,
  body[style] {
    background: #ffffff !important;
    background-color: #ffffff !important;
  }
  .letter-pdf-root table[align="center"] {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  /* Keep the email card at its native 600px width; zoom scales it to the page. */
  .letter-pdf-root .email-container,
  .letter-pdf-root table[width="600"],
  .letter-pdf-root table[width='600'] {
    width: 600px !important;
    max-width: 600px !important;
    min-width: 600px !important;
    margin: 0 !important;
    border: 0 !important;
    border-width: 0 !important;
    border-style: none !important;
    border-radius: 0 !important;
  }
</style>
</head>
<body>
  <div class="letter-pdf-stage">
    <div class="letter-pdf-root">${innerHtml}</div>
  </div>
</body>
</html>`;
}

function wrapEmailHtmlForPdf(html: string): string {
    const inner = looksLikeFullHtmlDocument(html) ? extractBodyInnerHtml(html) : html.trim();
    return buildLetterPdfDocument(inner);
}

function buildA4PdfDocument(innerHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style id="a4-pdf-print-shell">
  @page {
    size: ${A4_PAGE_WIDTH_MM}mm ${A4_PAGE_HEIGHT_MM}mm;
    margin: ${A4_PDF_MARGIN_TOP_MM}mm ${A4_PDF_MARGIN_RIGHT_MM}mm ${A4_PDF_MARGIN_BOTTOM_MM}mm ${A4_PDF_MARGIN_LEFT_MM}mm;
    background: #ffffff;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    background: #ffffff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
    font-family: Arial, Helvetica, sans-serif;
  }
  .a4-pdf-stage {
    width: 100%;
    background: #ffffff !important;
  }
  .a4-pdf-root {
    width: 100%;
    background: #ffffff !important;
  }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
</style>
</head>
<body>
  <div class="a4-pdf-stage">
    <div class="a4-pdf-root">${innerHtml}</div>
  </div>
</body>
</html>`;
}

function wrapHtmlForA4Pdf(html: string): string {
    const inner = looksLikeFullHtmlDocument(html) ? extractBodyInnerHtml(html) : html.trim();
    return buildA4PdfDocument(inner);
}

async function resolveLetterPdfExecutablePaths(): Promise<Array<string | undefined>> {
  const candidates: Array<string | undefined> = [];
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (envPath) candidates.push(envPath);

  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  }

  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
    }
  }

  try {
    const bundled = await puppeteer.executablePath();
    if (bundled) candidates.push(bundled);
  } catch {
    // Bundled Chromium unavailable ΓÇö try other candidates.
  }

  const seen = new Set<string>();
  const resolved: Array<string | undefined> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) resolved.push(candidate);
  }

  if (resolved.length === 0) {
    resolved.push(undefined);
  }
  return resolved;
}

async function launchLetterPdfBrowser(): Promise<Browser> {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
  ];

  const executablePaths = await resolveLetterPdfExecutablePaths();
  let lastError: unknown;

  for (const executablePath of executablePaths) {
    try {
      return await puppeteer.launch({
        headless: true,
        args: launchArgs,
        executablePath,
      });
    } catch (error) {
      lastError = error;
      console.warn(
        `${LOG_PREFIX} browser launch failed${executablePath ? ` (${executablePath})` : ''}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to launch PDF browser');
}

async function waitForImages(page: Page): Promise<void> {
    await page.evaluate((maxMs: number) => {
        type ImgEl = {
            complete: boolean;
            addEventListener: (
                type: string,
                listener: () => void,
                options?: { once?: boolean },
            ) => void;
        };
        const g = globalThis as unknown as {
            document: { images: ArrayLike<ImgEl> };
        };
        const imgs = Array.from(g.document.images);
        const pending = imgs
            .filter((img) => !img.complete)
            .map(
                (img) =>
                    new Promise<void>((resolve) => {
                        const done = () => resolve();
                        img.addEventListener('load', done, { once: true });
                        img.addEventListener('error', done, { once: true });
                        setTimeout(done, maxMs);
                    }),
            );
        return Promise.all(pending);
    }, IMAGE_WAIT_MS);
}

async function waitForFonts(page: Page): Promise<void> {
    await page
        .evaluate(() => {
            const g = globalThis as unknown as {
                document: { fonts?: { ready: Promise<unknown> } };
            };
            return g.document.fonts?.ready ?? Promise.resolve();
        })
        .catch(() => undefined);
}

/** Double rAF so first layout/paint after fonts/images settles before `page.pdf`. */
async function waitForNextPaint(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const g = globalThis as unknown as {
                    requestAnimationFrame: (cb: () => void) => number;
                };
                g.requestAnimationFrame(() => {
                    g.requestAnimationFrame(() => resolve());
                });
            }),
    );
}

type PdfDomEl = {
    tagName: string;
    classList: { contains: (name: string) => boolean };
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    style: {
        setProperty: (name: string, value: string, priority?: string) => void;
        transformOrigin: string;
        transform: string;
    };
    getBoundingClientRect: () => { top: number; bottom: number; height: number; width: number };
    offsetHeight: number;
    offsetWidth: number;
    parentElement: PdfDomEl | null;
    children: ArrayLike<PdfDomEl>;
    querySelector: (sel: string) => PdfDomEl | null;
    querySelectorAll: (sel: string) => ArrayLike<PdfDomEl>;
    appendChild: (child: PdfDomEl) => PdfDomEl;
    insertBefore: (node: PdfDomEl, ref: PdfDomEl | null) => PdfDomEl;
    remove: () => void;
};

type PdfDocumentEl = PdfDomEl & {
    createElement: (tag: string) => PdfDomEl;
    body: PdfDomEl;
};

/** Native email letter card width (px) — matches the Letters preview iframe. */
const LETTER_EMAIL_CARD_WIDTH_PX = 600;

/**
 * PDF-only DOM tweaks: strip the grey email canvas padding and tag the letter
 * card. Keeps the card at the email width (600px) so line-wrapping / height
 * match the Letters preview; a later zoom step scales it to the PDF page width.
 * Email HTML templates are left unchanged.
 */
async function prepareLetterDomForPdf(page: Page): Promise<void> {
    await page.evaluate((cardWidthPx: number) => {
        const g = globalThis as unknown as { document: PdfDomEl };
        const root = g.document.querySelector('.letter-pdf-root');
        if (!root) return;

        const attrWidth = (el: PdfDomEl) => (el.getAttribute('width') || '').trim();
        const inlineStyle = (el: PdfDomEl) => el.getAttribute('style') || '';

        const tables = Array.from(root.querySelectorAll('table'));
        for (const table of tables) {
            const w = attrWidth(table);
            const style = inlineStyle(table);
            const isEmailCard =
                table.classList.contains('email-container') ||
                w === '600' ||
                w === String(cardWidthPx) ||
                /(?:^|;)\s*(?:max-)?width\s*:\s*600px/i.test(style);
            if (!isEmailCard) continue;

            table.setAttribute('data-letter-pdf-card', '');
            table.setAttribute('width', String(cardWidthPx));
            table.style.setProperty('width', `${cardWidthPx}px`, 'important');
            table.style.setProperty('max-width', `${cardWidthPx}px`, 'important');
            table.style.setProperty('min-width', `${cardWidthPx}px`, 'important');
            table.style.setProperty('border', '0', 'important');
            table.style.setProperty('border-width', '0', 'important');
            table.style.setProperty('margin', '0', 'important');
        }

        const card =
            root.querySelector('[data-letter-pdf-card]') ??
            root.querySelector('.email-container');
        if (!card) return;

        let ancestor: PdfDomEl | null = card.parentElement;
        while (ancestor && ancestor !== root) {
            const tag = (ancestor.tagName || '').toUpperCase();
            if (tag === 'TD' || tag === 'TH' || tag === 'TABLE') {
                ancestor.style.setProperty('padding', '0', 'important');
                ancestor.style.setProperty('background', '#ffffff', 'important');
                ancestor.style.setProperty('background-color', '#ffffff', 'important');
                ancestor.style.setProperty('vertical-align', 'top', 'important');
            }
            ancestor = ancestor.parentElement;
        }
    }, LETTER_EMAIL_CARD_WIDTH_PX);
}

/**
 * Scale the 600px email letter up to the PDF page width with CSS `zoom` so
 * wrapping stays identical to the on-screen template (no height collapse).
 */
async function zoomLetterCardToPageWidth(
    page: Page,
    pageWidthPx: number,
    cardWidthPx: number = LETTER_EMAIL_CARD_WIDTH_PX,
): Promise<number> {
    const zoom = pageWidthPx / cardWidthPx;
    await page.evaluate(
        (args: { zoom: number; cardWidthPx: number }) => {
            const g = globalThis as unknown as { document: PdfDomEl };
            const root = g.document.querySelector('.letter-pdf-root');
            const card =
                g.document.querySelector('[data-letter-pdf-card]') ??
                g.document.querySelector('.email-container');
            if (!root || !card) return;

            card.setAttribute('width', String(args.cardWidthPx));
            card.style.setProperty('width', `${args.cardWidthPx}px`, 'important');
            card.style.setProperty('max-width', `${args.cardWidthPx}px`, 'important');
            card.style.setProperty('min-width', `${args.cardWidthPx}px`, 'important');

            // Chromium `zoom` scales layout boxes (unlike transform), so PDF
            // capture sees a full-page-width letter with preview wrapping.
            root.style.setProperty('zoom', String(args.zoom));
            root.style.setProperty('width', `${args.cardWidthPx}px`, 'important');
        },
        { zoom, cardWidthPx },
    );
    return zoom;
}

/** In-page fallback if the card cannot be found (min-height expressed in CSS px). */
const LETTER_PDF_MEASURE_FALLBACK_PX = mmToCssPx(LETTER_PDF_MEASURE_FALLBACK_MM);

/**
 * Height of the letter card only (header bars through footer accent strips).
 * Never uses body / documentElement scrollHeight — those equal the tall
 * Puppeteer viewport and produce a huge blank PDF.
 */
async function measureContentHeightPx(page: Page): Promise<number> {
    const minFallbackPx = LETTER_PDF_MEASURE_FALLBACK_PX;
    return page.evaluate((fallbackPx: number) => {
        const g = globalThis as unknown as { document: PdfDomEl };
        const root = g.document.querySelector('.letter-pdf-root');
        const card =
            g.document.querySelector('[data-letter-pdf-card]') ??
            g.document.querySelector('.email-container') ??
            root;
        if (!card) return fallbackPx;

        const includeRect = (
            top: number,
            bottom: number,
            rect: { top: number; bottom: number; height: number },
        ) => {
            if (!(rect.height > 0)) return { top, bottom };
            return {
                top: Math.min(top, rect.top),
                bottom: Math.max(bottom, rect.bottom),
            };
        };

        const cardRect = card.getBoundingClientRect();
        let top = cardRect.top;
        let bottom = cardRect.bottom;

        const descendants = [
            ...Array.from(card.querySelectorAll('tr')),
            ...Array.from(card.querySelectorAll('td')),
            ...Array.from(card.querySelectorAll('th')),
            ...Array.from(card.querySelectorAll('table')),
        ];
        for (const el of descendants) {
            const next = includeRect(top, bottom, el.getBoundingClientRect());
            top = next.top;
            bottom = next.bottom;
        }

        const fromDescendants = Math.max(0, bottom - top);
        const fromBox = Math.max(cardRect.height, card.offsetHeight || 0);
        return Math.ceil(Math.max(fromBox, fromDescendants));
    }, minFallbackPx);
}

async function applyDynamicPageSize(page: Page, widthMm: number, heightMm: number): Promise<void> {
    await page.addStyleTag({
        content: `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; background: #ffffff; }`,
    });
}

/**
 * Pin footer accent bars to the bottom of a full A4 page by inserting a spacer
 * row before the last card row. Avoids setting table/card height (which was
 * overflowing onto page 2) while keeping the letter page tall like the preview.
 */
async function pinFooterWithSpacer(page: Page, pageHeightPx: number): Promise<void> {
    await page.evaluate((targetHeightPx: number) => {
        const g = globalThis as unknown as { document: PdfDocumentEl };
        const doc = g.document;
        const card =
            doc.querySelector('[data-letter-pdf-card]') ??
            doc.querySelector('.email-container');
        if (!card || !(targetHeightPx > 0)) return;

        // Clear any prior spacer from a previous pass.
        Array.from(card.querySelectorAll('[data-letter-pdf-spacer]')).forEach((el) => {
            el.remove();
        });

        const directRows = Array.from(card.children).flatMap((child) => {
            const tag = (child.tagName || '').toUpperCase();
            if (tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT') {
                return Array.from(child.children).filter(
                    (row) => (row.tagName || '').toUpperCase() === 'TR',
                );
            }
            if (tag === 'TR') return [child];
            return [];
        });
        if (directRows.length < 2) return;

        const cardRect = card.getBoundingClientRect();
        const currentHeight = Math.ceil(
            Math.max(cardRect.height, card.offsetHeight || 0),
        );
        // Keep 2px under the page so Chromium never spills a blank page 2.
        const gap = Math.floor(targetHeightPx - currentHeight - 2);
        if (gap <= 0) return;

        const footerRow = directRows[directRows.length - 1];
        const parent = footerRow.parentElement;
        if (!parent) return;

        const spacerRow = doc.createElement('tr');
        spacerRow.setAttribute('data-letter-pdf-spacer', '');
        const spacerTd = doc.createElement('td');
        spacerTd.setAttribute('height', String(gap));
        spacerTd.style.setProperty('height', `${gap}px`, 'important');
        spacerTd.style.setProperty('line-height', `${gap}px`, 'important');
        spacerTd.style.setProperty('font-size', '0', 'important');
        spacerTd.style.setProperty('padding', '0', 'important');
        spacerTd.style.setProperty('margin', '0', 'important');
        spacerTd.style.setProperty('border', '0', 'important');
        spacerTd.appendChild(doc.createElement('span'));
        spacerRow.appendChild(spacerTd);
        parent.insertBefore(spacerRow, footerRow);
    }, pageHeightPx);
}

/**
 * If content is taller than one printable area, scale the root down slightly
 * so a single PDF page is more likely (optional; LETTER_PDF_FIT_ONE_PAGE=1).
 */
async function scaleLetterToFitOnePageIfNeeded(page: Page): Promise<void> {
    if (!FIT_ONE_PAGE) return;
    const widthMm = LETTER_PDF_PAGE_WIDTH_MM;
    const heightMm = LETTER_PDF_FIT_HEIGHT_MM;
    await page.evaluate(
        (args: { widthMm: number; heightMm: number }) => {
            const g = globalThis as unknown as {
                document: { querySelector: (sel: string) => PdfDomEl | null };
            };
            const root = g.document.querySelector('.letter-pdf-root');
            if (!root) return;

            const mmToPx = (mm: number) => (mm * 96) / 25.4;
            const pageInnerH = mmToPx(args.heightMm);
            const pageInnerW = mmToPx(args.widthMm);

            const rect = root.getBoundingClientRect();
            const h = Math.max(rect.height, root.offsetHeight || 0);
            const w = Math.max(rect.width, root.offsetWidth || 0);
            if (h <= pageInnerH && w <= pageInnerW) return;

            const scale = Math.min(pageInnerH / h, pageInnerW / w, 1) * 0.985;
            if (scale >= 0.999) return;

            root.style.transformOrigin = 'top center';
            root.style.transform = `scale(${scale})`;
        },
        { widthMm, heightMm },
    );
}

/**
 * Renders CRM letter / rich HTML email body to a single-page PDF buffer.
 * Width is A4 ({@link LETTER_PDF_PAGE_WIDTH_MM} mm). Height is at least a full
 * A4 sheet ({@link LETTER_PDF_MIN_PAGE_HEIGHT_MM}), or taller when content needs it.
 *
 * Layout matches the Letters preview: the email card stays 600px wide (same
 * wrapping / height), then CSS zoom scales it to the A4 page width. A spacer
 * pins footer bars to the bottom without overflowing onto page 2.
 */
export async function renderLetterHtmlToPdfBuffer(htmlBody: string): Promise<Buffer> {
    if (!htmlBody || !String(htmlBody).trim()) {
        throw new Error('HTML body is required for PDF generation');
    }

    let browser: Browser | undefined;
    const started = Date.now();
    try {
        browser = await launchLetterPdfBrowser();

        const page = await browser.newPage();

        // Screen paint path keeps template colors/gradients closer to the email preview.
        await page.emulateMediaType('screen');

        const pageWidthPx = mmToCssPx(LETTER_PDF_PAGE_WIDTH_MM);
        const measureViewportHeightPx = mmToCssPx(LETTER_PDF_MAX_HEIGHT_MM);

        // Measure at the email card width first so wrapping matches the preview.
        await page.setViewport({
            width: LETTER_EMAIL_CARD_WIDTH_PX,
            height: measureViewportHeightPx,
            deviceScaleFactor: 2,
        });

        const documentHtml = wrapEmailHtmlForPdf(htmlBody);
        await page.setContent(documentHtml, {
            waitUntil: 'load',
            timeout: SET_CONTENT_TIMEOUT_MS,
        });
        await waitForImages(page);
        await waitForFonts(page);
        await waitForNextPaint(page);
        await prepareLetterDomForPdf(page);
        await waitForNextPaint(page);

        // Natural preview height at 600px (same wrapping as Letters UI).
        const previewHeightPx = await measureContentHeightPx(page);
        const zoom = pageWidthPx / LETTER_EMAIL_CARD_WIDTH_PX;
        const zoomedContentHeightPx = Math.ceil(previewHeightPx * zoom);
        const measuredHeightMm =
            Math.ceil(pxToMm(zoomedContentHeightPx)) + LETTER_PDF_HEIGHT_SLACK_MM;
        const pageHeightMm = Math.min(
            LETTER_PDF_MAX_HEIGHT_MM,
            Math.max(LETTER_PDF_MIN_PAGE_HEIGHT_MM, measuredHeightMm),
        );
        const pageHeightPx = mmToCssPx(pageHeightMm);

        // Insert spacer in pre-zoom coordinates, then zoom to full page width.
        const targetLayoutHeightPx = Math.floor(pageHeightPx / zoom);
        await pinFooterWithSpacer(page, targetLayoutHeightPx);
        await waitForNextPaint(page);
        await zoomLetterCardToPageWidth(page, pageWidthPx, LETTER_EMAIL_CARD_WIDTH_PX);
        await waitForNextPaint(page);
        await scaleLetterToFitOnePageIfNeeded(page);
        await waitForNextPaint(page);

        const pdfViewportHeightPx = Math.max(
            pageHeightPx + LETTER_PDF_VIEWPORT_SLACK_PX,
            zoomedContentHeightPx + LETTER_PDF_VIEWPORT_SLACK_PX,
        );
        await page.setViewport({
            width: pageWidthPx,
            height: pdfViewportHeightPx,
            deviceScaleFactor: 2,
        });
        await waitForNextPaint(page);

        await applyDynamicPageSize(page, LETTER_PDF_PAGE_WIDTH_MM, pageHeightMm);

        const pdfUint8 = await page.pdf({
            width: `${LETTER_PDF_PAGE_WIDTH_MM}mm`,
            height: `${pageHeightMm}mm`,
            printBackground: true,
            preferCSSPageSize: false,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            omitBackground: false,
            tagged: false,
        });

        const buf = Buffer.from(pdfUint8);
        if (!buf.length) {
            throw new Error('Puppeteer returned an empty PDF buffer');
        }
        console.info(
            `${LOG_PREFIX} generated pdf bytes=${buf.length} previewHeightPx=${previewHeightPx} zoom=${zoom.toFixed(3)} pageHeightMm=${pageHeightMm} elapsedMs=${Date.now() - started}`,
        );
        return buf;
    } catch (err) {
        console.error(`${LOG_PREFIX} generation failed:`, err);
        throw err;
    } finally {
        if (browser) {
            await browser.close().catch((closeErr) => {
                console.error(`${LOG_PREFIX} browser.close failed:`, closeErr);
            });
        }
    }
}

/**
 * Renders HTML to a fixed A4 PDF (210├ù297 mm) ΓÇö same page size as standard contract pages.
 * Unlike {@link renderLetterHtmlToPdfBuffer}, page height is not shrunk to content.
 */
export async function renderHtmlToA4PdfBuffer(htmlBody: string): Promise<Buffer> {
    if (!htmlBody || !String(htmlBody).trim()) {
        throw new Error('HTML body is required for PDF generation');
    }

    let browser: Browser | undefined;
    const started = Date.now();
    try {
        browser = await launchLetterPdfBrowser();
        const page = await browser.newPage();
        await page.emulateMediaType('print');
        await page.setViewport({
            width: mmToCssPx(A4_PAGE_WIDTH_MM),
            height: mmToCssPx(A4_PAGE_HEIGHT_MM),
            deviceScaleFactor: 2,
        });

        const documentHtml = wrapHtmlForA4Pdf(htmlBody);
        await page.setContent(documentHtml, {
            waitUntil: 'load',
            timeout: SET_CONTENT_TIMEOUT_MS,
        });
        await waitForImages(page);
        await waitForFonts(page);
        await waitForNextPaint(page);

        const pdfUint8 = await page.pdf({
            format: 'a4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: {
                top: `${A4_PDF_MARGIN_TOP_MM}mm`,
                right: `${A4_PDF_MARGIN_RIGHT_MM}mm`,
                bottom: `${A4_PDF_MARGIN_BOTTOM_MM}mm`,
                left: `${A4_PDF_MARGIN_LEFT_MM}mm`,
            },
            omitBackground: false,
            tagged: false,
        });

        const buf = Buffer.from(pdfUint8);
        if (!buf.length) {
            throw new Error('Puppeteer returned an empty PDF buffer');
        }
        console.info(
            `${LOG_PREFIX} generated A4 pdf bytes=${buf.length} elapsedMs=${Date.now() - started}`,
        );
        return buf;
    } catch (err) {
        console.error(`${LOG_PREFIX} A4 generation failed:`, err);
        throw err;
    } finally {
        if (browser) {
            await browser.close().catch((closeErr) => {
                console.error(`${LOG_PREFIX} browser.close failed:`, closeErr);
            });
        }
    }
}

/** Safe ASCII-ish filename for MIME / filesystem (caller may add .pdf). */
export function sanitizeLetterPdfFilename(name: string): string {
    const trimmed = String(name || 'letter').trim() || 'letter';
    const cleaned = trimmed
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 180)
        .replace(/^-+|-+$/g, '');
    const base = cleaned || `letter-${randomBytes(4).toString('hex')}`;
    return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}
