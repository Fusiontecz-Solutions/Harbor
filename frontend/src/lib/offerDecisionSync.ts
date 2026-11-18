/** Dispatched after an offer-decision is saved elsewhere (e.g. approval modal). */
export const OFFER_DECISION_UPDATED_EVENT = "crm:offer-decision-updated";

export type OfferDecisionUpdatedDetail = {
    applicationId: string;
    /** When true, listeners should use local/redux state instead of refetching. */
    skipReload?: boolean;
};

export function emitOfferDecisionUpdated(
    applicationId: string | number,
    options?: { skipReload?: boolean },
) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
        new CustomEvent<OfferDecisionUpdatedDetail>(OFFER_DECISION_UPDATED_EVENT, {
            detail: {
                applicationId: String(applicationId),
                skipReload: options?.skipReload === true,
            },
        }),
    );
}

export function offerDecisionUpdateMatchesApplication(
    eventApplicationId: unknown,
    currentApplicationId: string | number | null | undefined,
): boolean {
    if (currentApplicationId == null || currentApplicationId === "") return false;
    if (eventApplicationId == null || eventApplicationId === "") return false;
    return String(eventApplicationId) === String(currentApplicationId);
}
