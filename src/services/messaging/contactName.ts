/**
 * The one name to show for a contact or lead: the sheet's owner name when it
 * has one, otherwise first + last name (older leads and manual contacts).
 */
export function contactDisplayName(
  c: { ownerName?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): string | null {
  if (!c) return null;
  const owner = String(c.ownerName ?? '').trim();
  if (owner) return owner;
  return [c.firstName, c.lastName].filter((v) => v && String(v).trim()).join(' ').trim() || null;
}

/** Split an owner name for the first/last fields merge templates use. */
export function splitOwnerName(ownerName: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = String(ownerName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || null };
}
