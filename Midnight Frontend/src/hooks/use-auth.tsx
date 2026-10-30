import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { LIMITS } from "@/lib/community-rules";

type AuthState = { user: User | null; session: Session | null; loading: boolean; signOut: (everywhere?: boolean) => Promise<void> };
const AuthContext = createContext<AuthState | null>(null);
const ACTIVE_KEY = "midnight:last-active";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    supabase.auth.getSession().then(async ({ data }) => {
      // Sessions end after a period without any visit.
      const last = Number(localStorage.getItem(ACTIVE_KEY) ?? 0);
      if (data.session && last && Date.now() - last > LIMITS.sessionIdleDays * 86_400_000) {
        await supabase.auth.signOut();
        setSession(null);
      } else setSession(data.session);
      setLoading(false);
    });
    const touch = () => localStorage.setItem(ACTIVE_KEY, String(Date.now()));
    touch();
    window.addEventListener("focus", touch);
    return () => { sub.subscription.unsubscribe(); window.removeEventListener("focus", touch); };
  }, [router, queryClient]);

  const signOut = async (everywhere = false) => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut({ scope: everywhere ? "global" : "local" });
    navigate({ to: "/auth", replace: true });
  };

  return <AuthContext.Provider value={{ user: session?.user ?? null, session, loading, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
