import { axiosGet } from "@/redux/axios";
import { isCloudinaryAssetUrl } from "@/lib/documentPreview";

/** Session cache so reopening Generate/View Contract does not re-download the same PDF. */
const blobUrlBySource = new Map<string, string>();
const inflightBlobBySource = new Map<string, Promise<string>>();

function blobCacheKey(url: string, name: string): string {
    return `${String(url || "").trim()}|${String(name || "").trim()}`;
}

function looksLikePdfHeader(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 4 &&
        bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46
    );
}

export async function blobUrlIsReadablePdf(url: string): Promise<boolean> {
    if (!String(url || "").startsWith("blob:")) return true;
    try {
        const res = await fetch(url);
        if (!res.ok) return false;
        const header = new Uint8Array(await (await res.blob()).slice(0, 5).arrayBuffer());
        return looksLikePdfHeader(header);
    } catch {
        return false;
    }
}

export function dropCachedPdfBlob(url: string, name = "document.pdf"): void {
    blobUrlBySource.delete(blobCacheKey(url, name));
}

/** Cloudinary raw uploads are served as octet-stream; PDF viewers need application/pdf. */
export function isCloudinaryRawPdfUrl(url: string): boolean {
    const u = String(url || "").trim();
    if (!u) return false;
    return (
        /res\.cloudinary\.com\/[^/]+\/raw\/upload\//i.test(u) &&
        /\.pdf($|[?#])/i.test(u)
    );
}

/**
 * Contract PDFs are stored as Cloudinary `image` (preferred) or legacy `raw`.
 * Both need the authenticated `/uploads/inline-preview` proxy for react-pdf.
 */
export function isCloudinaryPdfUrl(url: string, name = ""): boolean {
    const u = String(url || "").trim();
    if (!u || !isCloudinaryAssetUrl(u)) return false;
    if (/\.pdf($|[?#])/i.test(u)) return true;
    if (/\.pdf$/i.test(String(name || "").trim())) return true;
    // Funder contract uploads use image/upload + format=pdf; path may omit .pdf.
    return /\/(image|raw)\/upload\//i.test(u) && !/\.(png|jpe?g|gif|webp|bmp|svg)($|[?#])/i.test(u);
}

export async function fetchCloudinaryPdfBlobUrl(
    url: string,
    name = "document.pdf",
): Promise<string> {
    const key = blobCacheKey(url, name);
    const cached = blobUrlBySource.get(key);
    if (cached) {
        if (await blobUrlIsReadablePdf(cached)) return cached;
        blobUrlBySource.delete(key);
    }
    const inflight = inflightBlobBySource.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
        const response = await axiosGet("/uploads/inline-preview", {
            params: { url, name, mimeType: "application/pdf" },
            responseType: "blob",
        });
        const rawBlob =
            response.data instanceof Blob
                ? response.data
                : new Blob([response.data], { type: "application/pdf" });
        const header = new Uint8Array(await rawBlob.slice(0, 5).arrayBuffer());
        if (!looksLikePdfHeader(header)) {
            throw new Error("Inline preview did not return a PDF.");
        }
        // Force application/pdf — Cloudinary often returns octet-stream for raw/image PDFs.
        const blob = new Blob([rawBlob], { type: "application/pdf" });
        const blobUrl = URL.createObjectURL(blob);
        blobUrlBySource.set(key, blobUrl);
        return blobUrl;
    })();
    inflightBlobBySource.set(key, promise);
    try {
        return await promise;
    } finally {
        inflightBlobBySource.delete(key);
    }
}

/** Resolve a stored Cloudinary URL for in-browser PDF viewing (react-pdf / iframe). */
export async function resolvePdfViewUrl(
    url: string,
    name = "document.pdf",
): Promise<string> {
    const trimmed = String(url || "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) {
        if (await blobUrlIsReadablePdf(trimmed)) return trimmed;
        return "";
    }
    // Proxy all Cloudinary PDF deliveries (image + raw). Direct res.cloudinary.com
    // fetches fail in react-pdf (CORS / content-type), which shows the "Could not render" error.
    if (isCloudinaryPdfUrl(trimmed, name) || isCloudinaryRawPdfUrl(trimmed)) {
        return fetchCloudinaryPdfBlobUrl(trimmed, name);
    }
    return trimmed;
}
