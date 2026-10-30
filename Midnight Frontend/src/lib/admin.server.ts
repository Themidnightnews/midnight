import { getCookie, setCookie, deleteCookie, getRequestHeader } from "@tanstack/react-start/server";

// Server-only: admin sessions (httpOnly cookie → hashed token row) and site settings.
export const ADMIN_COOKIE = "mn_admin";
const SESSION_HOURS = 12;

export type AdminRole = "admin" | "editor";
export type AdminAccount = { id: string; username: string; email: string; role: AdminRole };

async function admin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function clientIp() {
  return getRequestHeader("cf-connecting-ip") ?? getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
export const ipHash = () => sha256(`midnight-admin:${clientIp()}`);

export async function audit(account: { id?: string | null; username?: string | null } | null, action: string, detail: Record<string, unknown> = {}) {
  const db = await admin();
  await db.from("admin_audit_log").insert({ account_id: account?.id ?? null, username: account?.username ?? null, action, detail: detail as never, ip_hash: await ipHash() });
}

export async function createSession(accountId: string) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
  const db = await admin();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db.from("admin_sessions").insert({
    account_id: accountId, token_hash: await sha256(token), ip_hash: await ipHash(),
    user_agent: (getRequestHeader("user-agent") ?? "").slice(0, 300), expires_at: expires.toISOString(),
  });
  setCookie(ADMIN_COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", expires });
}

export async function endSession() {
  const token = getCookie(ADMIN_COOKIE);
  if (token) {
    const db = await admin();
    await db.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", await sha256(token));
  }
  deleteCookie(ADMIN_COOKIE, { path: "/" });
}

/** Current admin from the session cookie, or null. */
export async function currentAdmin(): Promise<(AdminAccount & { sessionId: string }) | null> {
  const token = getCookie(ADMIN_COOKIE);
  if (!token) return null;
  const db = await admin();
  const { data } = await db
    .from("admin_sessions")
    .select("id, expires_at, revoked_at, admin_accounts!inner(id, username, email, role, disabled)")
    .eq("token_hash", await sha256(token))
    .maybeSingle();
  if (!data || data.revoked_at || new Date(data.expires_at) < new Date()) return null;
  const acc = data.admin_accounts as unknown as AdminAccount & { disabled: boolean };
  if (acc.disabled) return null;
  void db.from("admin_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return { id: acc.id, username: acc.username, email: acc.email, role: acc.role, sessionId: data.id };
}

/** Throws unless signed in; editors pass only when `role` is "editor". */
export async function requireAdmin(role: AdminRole = "admin") {
  const me = await currentAdmin();
  if (!me) throw new Error("Please sign in to the admin area");
  if (role === "admin" && me.role !== "admin") throw new Error("Only full admins can do this");
  return me;
}

export type SiteSettings = { maintenance_mode: boolean; maintenance_message: string; signups_enabled: boolean; comments_enabled: boolean };

export async function loadSettings(): Promise<SiteSettings> {
  const db = await admin();
  const { data } = await db.from("site_settings").select("maintenance_mode, maintenance_message, signups_enabled, comments_enabled").eq("id", 1).maybeSingle();
  return data ?? { maintenance_mode: false, maintenance_message: "", signups_enabled: true, comments_enabled: true };
}

/** Used by public write paths so a paused feature is refused on the server, not just hidden. */
export async function assertEnabled(key: "signups_enabled" | "comments_enabled") {
  const s = await loadSettings();
  if (s.maintenance_mode) throw new Error("The site is paused for maintenance right now.");
  if (!s[key]) throw new Error(key === "signups_enabled" ? "New sign-ups are paused right now." : "Comments are paused right now.");
}

export async function adminDb() {
  return admin();
}
