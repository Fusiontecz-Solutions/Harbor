import { axiosGet } from "@/redux/axios";
import {
    isTexasFundingGroupFunderProfile,
    persistedFunderProfileIdForApi,
} from "@/hooks/useFunderProfiles";
import type { FunderProfile } from "@/types/integrationSettingsTypes";
import { resolvePdfViewUrl, blobUrlIsReadablePdf } from "@/utils/cloudinaryPdfUrl";
import { PLATFORM_LAYOUT_KEYS } from "./platformDocumentConfig";

export type MainContractTemplatePreview = {
    url: string;
    name: string;
    layoutKey: string;
    source: "contract-templates" | "crm-pdf-url" | "docusign-download" | "fallback";
};

const previewCache = new Map<string, MainContractTemplatePreview>();
const previewInflight = new Map<string, Promise<MainContractTemplatePreview | null>>();
let crmContractTemplatesCache: {
    at: number;
    rows: Array<{
        layoutKey?: string;
        templateId?: string;
        pdfUrl?: string;
        name?: string;
        originalFileName?: string;
    }>;
} | null = null;
const CRM_TEMPLATES_TTL_MS = 5 * 60_000;

function previewCacheKey(options: {
    layoutKey: string;
    funderName?: string;
    funderProfileId?: string;
    state?: string;
}): string {
    return [
        String(options.layoutKey || "").trim(),
        String(options.funderProfileId || "").trim(),
        String(options.funderName || "").trim().toLowerCase(),
        String(options.state || "").trim().toLowerCase(),
    ].join("|");
}

function looksLikeDocusignUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(value || "").trim(),
    );
}

export function getCachedMainContractTemplatePreview(options: {
    layoutKey: string;
    funderName?: string | null;
    funderProfileId?: string | null;
    state?: string | null;
}): MainContractTemplatePreview | null {
    return (
        previewCache.get(
            previewCacheKey({
                layoutKey: String(options.layoutKey || "").trim(),
                funderName: String(options.funderName ?? "").trim(),
                funderProfileId: String(options.funderProfileId ?? "").trim(),
                state: String(options.state ?? "").trim(),
            }),
        ) ?? null
    );
}

function isFunderOwnedContractLayout(layoutKey: string, profile?: FunderProfile): boolean {
    const key = String(layoutKey || "").trim();
    if (key.startsWith("funder_")) return true;
    if (key === "texas_funding_group_contract") return true;
    if (profile && isTexasFundingGroupFunderProfile(profile)) return true;
    const profileKey = String(profile?.mainContractLayoutKey ?? "").trim();
    if (profileKey.startsWith("funder_")) return true;
    if (profileKey && profileKey !== PLATFORM_LAYOUT_KEYS.contract) return true;
    return false;
}

async function fetchCrmContractTemplateRows(): Promise<
    Array<{
        layoutKey?: string;
        templateId?: string;
        pdfUrl?: string;
        name?: string;
        originalFileName?: string;
    }>
> {
    if (
        crmContractTemplatesCache &&
        Date.now() - crmContractTemplatesCache.at < CRM_TEMPLATES_TTL_MS
    ) {
        return crmContractTemplatesCache.rows;
    }
    const res = await axiosGet("/contract/templates", {
        params: { type: "contract" },
    });
    const rows = (
        (res as { data?: { data?: unknown } })?.data?.data ??
        (res as { data?: unknown })?.data ??
        []
    ) as Array<{
        layoutKey?: string;
        templateId?: string;
        pdfUrl?: string;
        name?: string;
        originalFileName?: string;
    }>;
    const list = Array.isArray(rows) ? rows : [];
    crmContractTemplatesCache = { at: Date.now(), rows: list };
    return list;
}

async function fetchCrmTemplatePdfByLayoutKey(
    layoutKey: string,
    previewName: string,
): Promise<MainContractTemplatePreview | null> {
    const key = String(layoutKey || "").trim();
    if (!key) return null;
    try {
        const rows = await fetchCrmContractTemplateRows();
        const match = rows.find(
            (row) =>
                String(row.layoutKey || "").trim() === key ||
                String(row.templateId || "").trim() === key,
        );
        const pdfUrl = String(match?.pdfUrl || "").trim();
        if (!pdfUrl || !/^https?:\/\//i.test(pdfUrl)) return null;
        const name =
            String(match?.originalFileName || match?.name || "").trim() || previewName;
        const viewUrl = await resolvePdfViewUrl(pdfUrl, name);
        return {
            url: viewUrl,
            name,
            layoutKey: key,
            source: "crm-pdf-url",
        };
    } catch {
        return null;
    }
}

async function loadMainContractTemplatePreviewUncached(options: {
    funderName?: string | null;
    funderProfileId?: string | null;
    state?: string | null;
    layoutKey: string;
    previewName: string;
    fallbackUrl?: string | null;
    fallbackName?: string | null;
    findFunder?: (name?: string | null) => FunderProfile | undefined;
    findFunderById?: (id?: string | null) => FunderProfile | undefined;
}): Promise<MainContractTemplatePreview | null> {
    const layoutKey = String(options.layoutKey || "").trim() || PLATFORM_LAYOUT_KEYS.contract;
    const funderName = String(options.funderName ?? "").trim();
    const state = String(options.state ?? "").trim() || undefined;
    const funderProfileId = String(options.funderProfileId ?? "").trim();
    const profile =
        options.findFunderById?.(funderProfileId) ?? options.findFunder?.(funderName);
    const persistedProfileId =
        funderProfileId && !funderProfileId.startsWith("fallback-")
            ? funderProfileId
            : persistedFunderProfileIdForApi(profile);
    const funderOwnedLayout = isFunderOwnedContractLayout(layoutKey, profile);
    const usePlatformContractTemplateLatest =
        layoutKey === PLATFORM_LAYOUT_KEYS.contract && !funderOwnedLayout;

    if (usePlatformContractTemplateLatest) {
        try {
            const res = await axiosGet("/contract-templates/latest", {
                params: {
                    layoutKey,
                    ...(funderName ? { funderName } : {}),
                    ...(state ? { state } : {}),
                },
            });
            const data = (res as { data?: { data?: { url?: string; originalName?: string } } })
                ?.data?.data;
            if (data?.url) {
                const viewUrl = await resolvePdfViewUrl(
                    data.url,
                    data.originalName || options.previewName,
                );
                return {
                    url: viewUrl,
                    name: data.originalName || options.previewName,
                    layoutKey,
                    source: "contract-templates",
                };
            }
        } catch {
            /* try CRM layout download / fallback */
        }
    }

    // Prefer CRM BoldSignTemplate.pdfUrl (Cloudinary) — works for funder_* layout keys.
    const crmPreview = await fetchCrmTemplatePdfByLayoutKey(layoutKey, options.previewName);
    if (crmPreview?.url) return crmPreview;

    // Layout keys are CRM-sourced. Hitting DocuSign here only adds latency (and often 400s).
    if (looksLikeDocusignUuid(layoutKey)) {
        try {
            const response = await axiosGet(
                `/docusign/template/${encodeURIComponent(layoutKey)}/download`,
                {
                    responseType: "blob",
                    params: {
                        ...(funderName ? { funderName } : {}),
                        ...(persistedProfileId ? { funderProfileId: persistedProfileId } : {}),
                        ...(state ? { state } : {}),
                    },
                },
            );
            const blob =
                response?.data instanceof Blob
                    ? response.data
                    : new Blob([response?.data], { type: "application/pdf" });
            if (blob.size > 0 && blob.type !== "application/json") {
                return {
                    url: URL.createObjectURL(blob),
                    name: options.previewName,
                    layoutKey,
                    source: "docusign-download",
                };
            }
        } catch {
            /* fall through */
        }
    }

    const fallbackUrl = String(options.fallbackUrl ?? "").trim();
    if (fallbackUrl) {
        const viewUrl = await resolvePdfViewUrl(
            fallbackUrl,
            options.fallbackName || options.previewName,
        );
        return {
            url: viewUrl,
            name: options.fallbackName || options.previewName,
            layoutKey,
            source: "fallback",
        };
    }

    return null;
}

export async function fetchMainContractTemplatePreview(options: {
    funderName?: string | null;
    funderProfileId?: string | null;
    state?: string | null;
    layoutKey: string;
    previewName: string;
    fallbackUrl?: string | null;
    fallbackName?: string | null;
    funders?: FunderProfile[];
    findFunder?: (name?: string | null) => FunderProfile | undefined;
    findFunderById?: (id?: string | null) => FunderProfile | undefined;
}): Promise<MainContractTemplatePreview | null> {
    const layoutKey = String(options.layoutKey || "").trim() || PLATFORM_LAYOUT_KEYS.contract;
    const key = previewCacheKey({
        layoutKey,
        funderName: String(options.funderName ?? "").trim(),
        funderProfileId: String(options.funderProfileId ?? "").trim(),
        state: String(options.state ?? "").trim(),
    });
    const cached = previewCache.get(key);
    if (cached?.url) {
        if (!cached.url.startsWith("blob:") || (await blobUrlIsReadablePdf(cached.url))) {
            return cached;
        }
        previewCache.delete(key);
    }
    const inflight = previewInflight.get(key);
    if (inflight) return inflight;

    const promise = loadMainContractTemplatePreviewUncached(options).then((preview) => {
        if (preview?.url) previewCache.set(key, preview);
        return preview;
    });
    previewInflight.set(key, promise);
    try {
        return await promise;
    } finally {
        previewInflight.delete(key);
    }
}
