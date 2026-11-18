/**
 * Read an uploaded file into a Buffer, whichever way it arrived.
 *
 * Harbor configures `express-fileupload` with `useTempFiles: true` (see
 * src/index.ts). In that mode the library streams the upload to disk and leaves
 * `file.data` as an EMPTY buffer — reading `.data` silently yields zero bytes,
 * which downstream looks like "a spreadsheet with no rows" rather than an
 * error. The file has to be read back from `file.tempFilePath`.
 *
 * Also accepts a base64 body field so the same endpoints work from JSON clients
 * and API tests that cannot easily send multipart.
 */
import fs from 'fs';
import type { Request } from 'express';

interface UploadedFileLike {
  data?: Buffer;
  tempFilePath?: string;
  name?: string;
  size?: number;
}

/** Field names checked, in order, before giving up. */
const DEFAULT_FIELDS = ['file', 'sheet', 'contacts', 'recipients', 'upload'];

export interface ReadUploadResult {
  buffer: Buffer;
  fileName: string | null;
}

export function readUploadedFile(req: Request, fields: string[] = DEFAULT_FIELDS): ReadUploadResult | null {
  const files = (req as Request & {
    files?: Record<string, UploadedFileLike | UploadedFileLike[]>;
  }).files;

  if (files) {
    for (const field of fields) {
      const entry = files[field];
      const file = Array.isArray(entry) ? entry[0] : entry;
      if (!file) continue;

      // Temp-file mode: the bytes are on disk, `data` is empty.
      if (file.tempFilePath) {
        try {
          const buffer = fs.readFileSync(file.tempFilePath);
          if (buffer.length > 0) return { buffer, fileName: file.name ?? null };
        } catch (err) {
          console.error('[readUploadedFile] failed to read temp file:', file.tempFilePath, (err as Error)?.message);
        }
      }

      if (file.data && file.data.length > 0) {
        return { buffer: file.data, fileName: file.name ?? null };
      }
    }
  }

  const base64 = String((req.body as Record<string, unknown>)?.fileBase64 ?? '').trim();
  if (base64) {
    try {
      const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buffer.length > 0) {
        const fileName = (req.body as Record<string, unknown>)?.fileName;
        return { buffer, fileName: fileName ? String(fileName) : null };
      }
    } catch {
      /* fall through to null — the caller reports "no usable file" */
    }
  }

  return null;
}

/**
 * Best-effort cleanup of temp files after processing. `useTempFiles` does not
 * delete them on its own, so a busy import endpoint would otherwise fill the
 * system temp directory.
 */
export function cleanupUploadedTempFiles(req: Request): void {
  const files = (req as Request & {
    files?: Record<string, UploadedFileLike | UploadedFileLike[]>;
  }).files;
  if (!files) return;

  for (const entry of Object.values(files)) {
    const list = Array.isArray(entry) ? entry : [entry];
    for (const file of list) {
      if (!file?.tempFilePath) continue;
      fs.promises.unlink(file.tempFilePath).catch(() => undefined);
    }
  }
}
