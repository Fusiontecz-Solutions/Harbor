import { pdfjs } from "react-pdf";

/**
 * Same-origin worker from /public/pdf.worker.min.mjs.
 * Must match react-pdf's pdfjs-dist version (4.8.69).
 */
if (typeof window !== "undefined") {
    const base = import.meta.env.BASE_URL || "/";
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
}

export { pdfjs };
