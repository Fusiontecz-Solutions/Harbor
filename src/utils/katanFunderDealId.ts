export type KatanDealIdPrefix = 'KK' | 'KC';

export type ResolvedKatanFunder = {
    /** Canonical stored label, e.g. `Katan II`. */
    organization: 'Katan II' | 'Katan III';
    prefix: KatanDealIdPrefix;
};

/** Compact deal id token (no spaces/dashes), uppercased. */
export function compactDealIdToken(dealIdRaw: string | null | undefined): string {
    let normalized = String(dealIdRaw ?? '')
        .trim()
        .toUpperCase();
    if (!normalized) return '';
    normalized = normalized.replace(/^['']+/g, '');
    return normalized.replace(/[\s\-_/]+/g, '');
}

/**
 * Maps contract/business funder selection to Katan org + deal id prefix.
 * Accepts Roman (`Katan II`) or Arabic (`Katan 2`) labels.
 */
export function resolveKatanFunderFromName(
    funderNameRaw: string | null | undefined,
): ResolvedKatanFunder | null {
    const normalized = String(funderNameRaw ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    if (!normalized) return null;

    if (
        normalized === 'katan ii' ||
        normalized === 'katan 2' ||
        normalized === 'katan2'
    ) {
        return { organization: 'Katan II', prefix: 'KK' };
    }
    if (
        normalized === 'katan iii' ||
        normalized === 'katan 3' ||
        normalized === 'katan3'
    ) {
        return { organization: 'Katan III', prefix: 'KC' };
    }
    return null;
}

export function dealIdMatchesFunderPrefix(
    dealIdRaw: string | null | undefined,
    prefix: KatanDealIdPrefix,
): boolean {
    const compact = compactDealIdToken(dealIdRaw);
    return compact.startsWith(prefix);
}

/**
 * Allocate a new KK/KC serial only when `dealId` is empty or the funder switches
 * between Katan II (`KK`) and Katan III (`KC`). Other existing ids (e.g. `WF…`) are left unchanged.
 */
export function shouldAllocateKatanDealId(
    dealIdRaw: string | null | undefined,
    targetPrefix: KatanDealIdPrefix,
): boolean {
    const compact = compactDealIdToken(dealIdRaw);
    if (!compact) return true;

    const hasKk = compact.startsWith('KK');
    const hasKc = compact.startsWith('KC');

    if (targetPrefix === 'KK' && hasKc) return true;
    if (targetPrefix === 'KC' && hasKk) return true;

    return false;
}
