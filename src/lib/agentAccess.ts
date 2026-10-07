import { normalizeRoleKey } from "@/lib/sessionRole";

/**
 * What an AGENT may reach.
 *
 * Harbor is otherwise a Super Admin application: the login gate and the layout
 * guards reject every other role. Agents are the exception, admitted for the
 * communication side only — they work the leads distributed to them and the
 * conversations on their own sending number, and the deal pipeline stays
 * Super-Admin-only exactly as before.
 *
 * The allowlist is deliberately positive: a new page is invisible to agents
 * until it is named here, rather than exposed by default.
 */
export function isAgentRole(role: string | null | undefined): boolean {
  return normalizeRoleKey(role ?? "") === "AGENT";
}

/** Where an agent lands at sign-in, and where a blocked path sends them. */
export const AGENT_HOME_PATH = "/inbox";

const AGENT_ALLOWED_EXACT = new Set([
  "/inbox",
  "/broadcasts",
  "/messaging-contacts",
  "/notifications",
  "/user-setting",
]);

const AGENT_ALLOWED_PREFIXES = ["/broadcasts/"] as const;

/**
 * Admin-only messaging screens. Assigning a sending number or distributing
 * leads decides what other people can see, so it stays with Super Admins —
 * these are blocked even though they sit under Communication.
 */
const AGENT_BLOCKED_PATH_SNIPPETS = [
  "/messaging-senders",
  "/lead-distribution",
  "/messaging-performance",
  "/send-windows",
] as const;

export function isAgentAllowedPath(pathname: string): boolean {
  const path = pathname.split("?")[0] || "/";

  for (const snippet of AGENT_BLOCKED_PATH_SNIPPETS) {
    if (path.includes(snippet)) return false;
  }

  if (AGENT_ALLOWED_EXACT.has(path)) return true;

  return AGENT_ALLOWED_PREFIXES.some(
    (prefix) => path.startsWith(prefix) && path.length > prefix.length,
  );
}
