export const INBOX_TABS = [
  'regular',
  'interested',
  'not-interested',
  'unreplied',
  'opt-out',
] as const;

export type InboxTab = (typeof INBOX_TABS)[number];

export function normalizeInboxTab(filter: string): InboxTab {
  if (filter === 'opted-out') return 'opt-out';
  if (filter === 'un-interested') return 'not-interested';
  if ((INBOX_TABS as readonly string[]).includes(filter)) return filter as InboxTab;
  return 'regular';
}

export function tabSkipsBroadcastVisibility(tab: InboxTab): boolean {
  return tab === 'unreplied';
}
