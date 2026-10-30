import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { MAX_ACCOUNTS_PER_ADDRESS, SIGNUP_WINDOW_HOURS, signupLimitReached } from "./signup-rules";

const input = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  username: z.string().trim().min(3).max(30),
});

async function hashIp(ip: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`midnight-signup:${ip}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an account instantly; no confirmation email is ever sent. A network address
 * that already created MAX_ACCOUNTS_PER_ADDRESS accounts in the window is refused.
 */
export const instantSignUp = createServerFn({ method: "POST" })
  .inputValidator((d) => input.parse(d))
  .handler(async ({ data }) => {
    await (await import("./admin.server")).assertEnabled("signups_enabled");
    const ip =
      getRequestHeader("cf-connecting-ip") ??
      getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const ipHash = await hashIp(ip);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - SIGNUP_WINDOW_HOURS * 3600_000).toISOString();
    const { count, error: countErr } = await supabaseAdmin
      .from("signup_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);
    if (countErr) throw new Error("Sign-up is unavailable right now. Please try again.");
    if (signupLimitReached(count ?? 0)) return { status: "limited" as const, limit: MAX_ACCOUNTS_PER_ADDRESS };

    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { username: data.username },
    });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("signup_attempts").insert({ ip_hash: ipHash });
    return { status: "created" as const };
  });

/** Explains a failed email sign-in precisely: missing account, no password set, or wrong password. */
export const explainSignInFailure = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ email: z.string().trim().email().max(254) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: status } = await supabaseAdmin.rpc("account_login_status", { _email: data.email });
    return (status ?? "unknown") as "no_account" | "social_only" | "unconfirmed" | "has_password" | "unknown";
  });
