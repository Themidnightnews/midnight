import { useEffect, useRef, useState } from "react";
import { PageLock } from "@/components/page-lock";
import { AccountButton } from "@/components/account-button";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MidnightLogo } from "@/components/news-bits";
import { searchArticles } from "@/data/news";
import { searchTrends } from "@/data/trends";
import { useAuth } from "@/hooks/use-auth";

/** Minimal header for article, report and resource pages: logo · centred search · report. */
export function CompactHeader() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Node && !boxRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  const q = query.trim().toLowerCase();
  // Inside Midnight Trends the search only ever looks at trends; elsewhere it only sees news.
  const inTrends = useRouterState({ select: (st) => st.location.pathname === "/trends" || st.location.pathname.startsWith("/trends/") });
  const results = !q ? [] : inTrends
    ? searchTrends(q).slice(0, 6).map((t) => ({ slug: t.slug, title: t.title, tag: `#${t.hashtags[0] ?? "Trending"}` }))
    : searchArticles(q).slice(0, 6);
  const submit = () => {
    if (!q) return;
    setOpen(false);
    if (inTrends) navigate({ to: "/trends", search: { q: query.trim() } });
    else navigate({ to: "/search", search: { q: query.trim() } });
  };

  return (
    <>
      <PageLock active={open && !!q} onClose={() => setOpen(false)} />
      <div aria-hidden className="header-haze pointer-events-none fixed inset-x-0 top-0 z-40 h-28" />
      <header className="fixed inset-x-0 top-4 z-50 mx-auto max-w-7xl px-4">
        <nav className="glass grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-full py-2.5 pr-2.5 pl-4 sm:grid-cols-[1fr_minmax(0,28rem)_1fr] sm:pl-6">
          <Link to="/" className="flex items-center gap-2 justify-self-start text-2xl font-extrabold tracking-tight">
            <MidnightLogo />
            <span className="hidden md:inline">midnight</span>
          </Link>

          <div ref={boxRef} className="relative w-full">
            <div className="search-field flex h-11 items-center gap-2 rounded-full px-3 sm:px-4">
              <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={inTrends ? "Search trends…" : "Search…"}
                aria-label={inTrends ? "Search trends" : "Search articles"}
                className="min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
              />
              {query && (
                <button aria-label="Clear search" onClick={() => setQuery("")} className="grid h-7 w-7 place-items-center rounded-full hover:bg-navigation-highlight">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 justify-self-end md:gap-4 lg:gap-5 xl:gap-6">
            {user ? <AccountButton compact /> : (
              <Button asChild className="h-11 rounded-full px-4 font-bold sm:px-6">
                <Link to="/midnight-report">The Report</Link>
              </Button>
            )}
          </div>
        </nav>
            {open && q && (
              <div ref={panelRef} className="glass mx-auto mt-3 w-full max-w-md max-h-[60dvh] overflow-y-auto rounded-[1.5rem] p-2">
                {results.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">{inTrends ? "No trends match" : "No stories match"} “{query}”.</p>}
                {results.map((r) => (
                  <Link key={r.slug} to={inTrends ? "/trends/$slug" : "/article/$slug"} params={{ slug: r.slug }} onClick={() => setOpen(false)}
                    className="flex min-w-0 items-center gap-3 rounded-2xl px-4 py-2.5 hover:bg-navigation-highlight">
                    <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold tracking-wider text-primary uppercase">{r.tag}</span>
                    <span className="truncate text-sm font-medium">{r.title}</span>
                  </Link>
                ))}
                {results.length > 0 && (
                  <button onClick={submit} className="w-full rounded-2xl px-4 py-2.5 text-left text-sm font-semibold text-primary hover:bg-navigation-highlight">
                    See all results →
                  </button>
                )}
              </div>
            )}
      </header>
    </>
  );
}
