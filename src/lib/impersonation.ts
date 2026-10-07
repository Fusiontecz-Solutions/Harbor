import axios from "axios";
import { clearCrmCacheOnLogout } from "@/lib/crmCache";
import { clearHttpGetCache } from "@/lib/httpGetCache";
import { clearAllPersistentCaches } from "@/lib/persistentCache/clearAllPersistentCaches";
import { AGENT_HOME_PATH } from "@/lib/agentAccess";

/**
 * Admin "switch user".
 *
 * The backend issues a real session token for the target user, so every page
 * behaves exactly as it does for that user — their inbox, their sending
 * number, their leads. The admin's own session is parked under separate keys
 * and restored on switch-back; it is never sent while acting as the user,
 * except to authorize switching to someone else.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

const IMPERSONATOR_TOKEN_KEY = "impersonatorToken";
const IMPERSONATOR_USER_KEY = "impersonatorUser";
const IMPERSONATOR_ROLE_KEY = "impersonatorRole";

export type ImpersonatorSession = {
  token: string;
  user: { firstName?: string; lastName?: string; email?: string } | null;
};

export function getImpersonator(): ImpersonatorSession | null {
  const token = localStorage.getItem(IMPERSONATOR_TOKEN_KEY);
  if (!token) return null;
  let user: ImpersonatorSession["user"] = null;
  try {
    user = JSON.parse(localStorage.getItem(IMPERSONATOR_USER_KEY) || "null");
  } catch {
    user = null;
  }
  return { token, user };
}

export function isImpersonating(): boolean {
  return Boolean(localStorage.getItem(IMPERSONATOR_TOKEN_KEY));
}

/** Token that carries admin rights: the parked one while switched, else the live one. */
export function getAdminToken(): string | null {
  return localStorage.getItem(IMPERSONATOR_TOKEN_KEY) || localStorage.getItem("token");
}

function clearImpersonatorKeys() {
  localStorage.removeItem(IMPERSONATOR_TOKEN_KEY);
  localStorage.removeItem(IMPERSONATOR_USER_KEY);
  localStorage.removeItem(IMPERSONATOR_ROLE_KEY);
}

async function clearSessionCaches() {
  clearCrmCacheOnLogout();
  clearHttpGetCache();
  await clearAllPersistentCaches().catch(() => undefined);
}

/**
 * Best effort: expire a token so it cannot outlive the switch. Raw axios on
 * purpose — the shared instance treats any 401 as "sign out and go to login",
 * which an already-expired token must not trigger here.
 */
async function revokeToken(token: string | null) {
  if (!token) return;
  await axios
    .post(`${API_BASE_URL}/auth/logout`, undefined, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => undefined);
}

export async function switchToUser(userId: string): Promise<void> {
  const adminToken = getAdminToken();
  if (!adminToken) throw new Error("Not signed in");

  const response = await axios.post(
    `${API_BASE_URL}/users/impersonate`,
    { userId },
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const { token, user } = response.data ?? {};
  if (!token || !user) throw new Error("Switch failed");

  if (isImpersonating()) {
    await revokeToken(localStorage.getItem("token"));
  } else {
    localStorage.setItem(IMPERSONATOR_TOKEN_KEY, adminToken);
    localStorage.setItem(IMPERSONATOR_USER_KEY, localStorage.getItem("user") || "null");
    localStorage.setItem(IMPERSONATOR_ROLE_KEY, localStorage.getItem("role") || "");
  }

  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify(user));
  localStorage.setItem("role", user.role);

  await clearSessionCaches();
  window.location.assign(AGENT_HOME_PATH);
}

export async function switchBackToAdmin(): Promise<void> {
  const parked = getImpersonator();
  if (!parked) return;

  await revokeToken(localStorage.getItem("token"));

  localStorage.setItem("token", parked.token);
  localStorage.setItem("user", localStorage.getItem(IMPERSONATOR_USER_KEY) || "null");
  localStorage.setItem("role", localStorage.getItem(IMPERSONATOR_ROLE_KEY) || "");
  clearImpersonatorKeys();

  await clearSessionCaches();
  window.location.assign("/");
}

/**
 * Called on logout: signing out while switched ends the admin session too,
 * otherwise the parked admin token would linger in storage.
 */
export async function endImpersonationOnLogout(): Promise<void> {
  const parked = getImpersonator();
  clearImpersonatorKeys();
  if (parked) await revokeToken(parked.token);
}

/** On a 401 the stored sessions are unusable; drop the parked one as well. */
export function clearImpersonationState(): void {
  clearImpersonatorKeys();
}
