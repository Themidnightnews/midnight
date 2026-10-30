import { supabase } from "@/integrations/supabase/client";

/** GA4 measurement ID. Set VITE_GA_MEASUREMENT_ID (e.g. in Vercel → Settings → Environment Variables). */
export const GA_ID: string | undefined = import.meta.env["VITE_GA_MEASUREMENT_ID"] || undefined;

declare global {
  interface Window { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void }
}

function visitorId() {
  try {
    let id = localStorage.getItem("mn_vid");
    if (!id) { id = crypto.randomUUID().replace(/-/g, ""); localStorage.setItem("mn_vid", id); }
    return id;
  } catch { return "anonymous0"; }
}

function device() {
  const w = window.innerWidth;
  return w < 640 ? "mobile" : w < 1024 ? "tablet" : "desktop";
}

let lastPath = "";
/** Records one visit per path change in our own stats and in Google Analytics. Admin pages are never counted. */
export function trackPageView(path: string) {
  if (typeof window === "undefined" || path === lastPath || path.startsWith("/admin")) return;
  const ref = lastPath ? "" : document.referrer;
  lastPath = path;
  const slug = path.match(/^\/article\/([^/?#]+)/)?.[1] ?? null;
  let referrer: string | null = null;
  try { referrer = ref && new URL(ref).host !== location.host ? new URL(ref).host : null; } catch { /* ignore */ }
  void supabase.from("page_views").insert({
    path: path.slice(0, 500), article_slug: slug ? decodeURIComponent(slug).slice(0, 300) : null,
    referrer, visitor_id: visitorId(), device: device(),
  }).then(() => {});
  if (GA_ID && window.gtag) window.gtag("event", "page_view", { page_path: path, page_location: location.href, page_title: document.title });
}
