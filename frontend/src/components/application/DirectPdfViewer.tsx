import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Document, Page } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "@/lib/pdfjsWorker";
import {
    dropCachedPdfBlob,
    resolvePdfViewUrl,
} from "@/utils/cloudinaryPdfUrl";
import { cn } from "@/lib/utils";

const FIRST_PAINT_PAGES = 1;
const PAGE_RENDER_INTERVAL_MS = 35;

type DirectPdfViewerProps = {
    fileUrl: string;
    /** Original http(s) URL to retry through the preview proxy if `fileUrl` is a dead blob. */
    sourceUrl?: string | null;
    fileName?: string;
    errorMessage?: string;
    className?: string;
};

function looksLikePdfHeader(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 4 &&
        bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46
    );
}

async function readPdfBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch PDF (${res.status})`);
    }
    const buf = await res.arrayBuffer();
    if (!looksLikePdfHeader(new Uint8Array(buf.slice(0, 5)))) {
        throw new Error("Response was not a PDF.");
    }
    return buf.slice(0);
}

/**
 * Contract/ACH preview: first page paints immediately, remaining pages stream in
 * so a 20–40 page package does not block the modal for minutes.
 *
 * The PDF is held as a Blob (copied bytes). react-pdf otherwise transfers the
 * ArrayBuffer to the worker and later parent re-renders fail with
 * "Could not render this PDF" even though Network shows the blob as 200.
 */
export default function DirectPdfViewer({
    fileUrl,
    sourceUrl = null,
    fileName = "document.pdf",
    errorMessage = "Could not render this PDF in the viewer.",
    className,
}: DirectPdfViewerProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [numPages, setNumPages] = useState<number | null>(null);
    const [renderedPages, setRenderedPages] = useState(FIRST_PAINT_PAGES);
    const [pageWidth, setPageWidth] = useState(640);
    const [pdfFile, setPdfFile] = useState<Blob | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setLoadError(null);
        setPdfFile(null);
        setNumPages(null);
        setRenderedPages(FIRST_PAINT_PAGES);

        void (async () => {
            const candidates = [
                fileUrl,
                String(sourceUrl || "").trim(),
            ].filter((url, index, list) => url && list.indexOf(url) === index);

            let lastError: unknown = null;
            for (const candidate of candidates) {
                try {
                    const viewUrl = await resolvePdfViewUrl(candidate, fileName);
                    if (!viewUrl) continue;
                    const buf = await readPdfBytes(viewUrl);
                    if (cancelled) return;
                    setPdfFile(new Blob([buf], { type: "application/pdf" }));
                    return;
                } catch (error) {
                    lastError = error;
                    if (candidate.startsWith("http")) {
                        dropCachedPdfBlob(candidate, fileName);
                    } else if (sourceUrl) {
                        dropCachedPdfBlob(String(sourceUrl), fileName);
                    }
                }
            }
            if (!cancelled) {
                setLoadError(
                    lastError instanceof Error ? lastError.message : errorMessage,
                );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [fileUrl, sourceUrl, fileName, errorMessage, reloadToken]);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const measure = () => {
            const w = el.clientWidth;
            if (w > 0) setPageWidth(Math.max(280, w - 4));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (!numPages || numPages <= FIRST_PAINT_PAGES) return;
        setRenderedPages(FIRST_PAINT_PAGES);
        const id = window.setInterval(() => {
            setRenderedPages((prev) => {
                if (prev >= numPages) {
                    window.clearInterval(id);
                    return prev;
                }
                return prev + 1;
            });
        }, PAGE_RENDER_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [numPages, pdfFile]);

    const documentFile = useMemo(() => pdfFile, [pdfFile]);
    const pagesToShow = numPages ? Math.min(renderedPages, numPages) : 0;

    return (
        <div
            ref={wrapRef}
            className={cn(
                "absolute inset-0 overflow-y-auto overflow-x-hidden bg-slate-100 dark:bg-slate-950",
                className,
            )}
        >
            {loadError ? (
                <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-4">
                    <p className="text-center text-xs text-slate-500">{loadError}</p>
                    <button
                        type="button"
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        onClick={() => setReloadToken((n) => n + 1)}
                    >
                        Retry PDF
                    </button>
                </div>
            ) : !documentFile ? (
                <div className="flex min-h-[200px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" aria-hidden />
                </div>
            ) : (
                <Document
                    file={documentFile}
                    onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                    onLoadError={(err) => {
                        const msg = String(err?.message || "");
                        setLoadError(
                            /worker|api version|fake worker/i.test(msg)
                                ? "PDF viewer failed to start. Refresh the page and try again."
                                : errorMessage,
                        );
                    }}
                    loading={
                        <div className="flex min-h-[200px] items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-slate-400" aria-hidden />
                        </div>
                    }
                    error={
                        <div className="flex min-h-[200px] items-center justify-center px-4">
                            <p className="text-center text-xs text-slate-500">{errorMessage}</p>
                        </div>
                    }
                    className="flex w-full flex-col items-center gap-3 py-3"
                >
                    {pagesToShow
                        ? Array.from({ length: pagesToShow }, (_, i) => (
                              <Page
                                  key={i + 1}
                                  pageNumber={i + 1}
                                  width={pageWidth}
                                  className="bg-white shadow-md"
                                  renderTextLayer={i < 2}
                                  renderAnnotationLayer={false}
                              />
                          ))
                        : null}
                </Document>
            )}
        </div>
    );
}
