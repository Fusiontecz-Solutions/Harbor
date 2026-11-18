import type { ApplicationLetterStatus } from "@/types/applicationTypes";

const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  processed: "Sent",
  delivered: "Delivered",
  opened: "Opened",
  open: "Opened",
  clicked: "Clicked",
  click: "Clicked",
  deferred: "Deferred",
  queued: "Queued",
  failed: "Failed",
  bounced: "Bounced",
  bounce: "Bounced",
  dropped: "Dropped",
  spam: "Spam",
  unsubscribed: "Unsubscribed",
};

export function letterStatusLabel(status: string | null | undefined): string {
  if (!status) return "Not sent";
  const normalized = status.toLowerCase();
  return STATUS_LABELS[normalized] ?? status;
}

export function letterTypeLabel(
  letterType: ApplicationLetterStatus["letterType"] | null | undefined,
): string {
  if (letterType === "zero_balance") return "ZBL";
  if (letterType === "payoff") return "Payoff";
  return "Letter";
}

export function letterStatusBadgeClass(status: string | null | undefined): string {
  const normalized = String(status || "").toLowerCase();
  switch (normalized) {
    case "sent":
    case "processed":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "delivered":
      return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "opened":
    case "open":
      return "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300";
    case "clicked":
    case "click":
      return "border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
    case "failed":
    case "bounced":
    case "bounce":
    case "dropped":
      return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
    case "spam":
      return "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300";
    case "deferred":
    case "queued":
      return "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300";
    default:
      return "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300";
  }
}

/** Resolve Payoff + ZBL statuses for display (supports legacy single `letterStatus`). */
export function resolveApplicationLetterStatuses(app: {
  letterStatuses?: ApplicationLetterStatus[] | null;
  letterStatus?: ApplicationLetterStatus | null;
}): ApplicationLetterStatus[] {
  if (Array.isArray(app.letterStatuses) && app.letterStatuses.length > 0) {
    return app.letterStatuses.filter((entry) => Boolean(entry?.status));
  }
  if (app.letterStatus?.status) return [app.letterStatus];
  return [];
}

const LETTER_STATUS_RANK: Record<string, number> = {
  queued: 1,
  sent: 2,
  processed: 2,
  deferred: 3,
  delivered: 4,
  opened: 5,
  open: 5,
  clicked: 6,
  click: 6,
  bounced: 7,
  bounce: 7,
  dropped: 7,
  failed: 7,
  spam: 8,
  unsubscribed: 4,
};

export function letterEngagementRank(status: string | null | undefined): number {
  return LETTER_STATUS_RANK[String(status || "").trim().toLowerCase()] ?? 0;
}

/**
 * Upsert one letter-type status into the list (used by SendGrid socket updates).
 * Never downgrades engagement for the same letter type.
 */
export function mergeLetterStatusEntry(
  existing: ApplicationLetterStatus[] | null | undefined,
  incoming: ApplicationLetterStatus,
): ApplicationLetterStatus[] {
  const list = Array.isArray(existing) ? [...existing] : [];
  const idx = list.findIndex((entry) => entry.letterType === incoming.letterType);
  if (idx < 0) {
    list.push(incoming);
  } else {
    const prior = list[idx];
    if (letterEngagementRank(incoming.status) >= letterEngagementRank(prior.status)) {
      list[idx] = { ...prior, ...incoming };
    }
  }
  list.sort((a, b) => {
    const typeOrder =
      (a.letterType === "payoff" ? 0 : 1) - (b.letterType === "payoff" ? 0 : 1);
    if (typeOrder !== 0) return typeOrder;
    const aAt = a.sentAt ? Date.parse(a.sentAt) : 0;
    const bAt = b.sentAt ? Date.parse(b.sentAt) : 0;
    return bAt - aAt;
  });
  return list;
}
