<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- The canonical news catalogue owns each story's category and image; listing cards resolve these by slug to keep detail pages consistent.
- Both header category menus use navigationSections from the canonical catalogue, falling back to existing labels only when no sections are loaded, so stored slugs and newly added categories stay accessible consistently.
- Section sorting uses optional publication timestamps, readership counts and share counts; never invent engagement data for archived stories.
- There is no newsletter; the header's primary button links to /midnight-report. Report edition dates come from src/lib/report-dates.ts until reports are stored in a database.
- The full navigation header (SiteHeader) appears only on "/" and "/section/*"; every other route uses the independent CompactHeader (logo, centred search, Report button), chosen in __root by pathname.
- Every content route sets a self-referencing relative canonical link; articles also emit NewsArticle and BreadcrumbList JSON-LD so crawlers can follow the site structure.
- Large photo cards (BigCard, home lead) carry a max height and section lead photos a fixed aspect ratio, so neighbouring lists never stretch them; overflow stories flow below.
- MongoDB document validation and indexes live in src/lib/mongodb; generate mongodb/schema.json from those contracts so database and application shapes cannot drift.
- MongoDB integration must implement the server-only EditorialRepository contract; do not replace live catalogue reads until credentials, image URLs and deployed connectivity have been verified, to avoid blanking the current site.
- Content migration is an explicit operator-run export/import, never request-time seeding; preserve existing IDs, slugs, placements and sample provenance so migration does not manufacture real measurements.
- Report copy lives in src/data/report.ts and is shared by the sample screen and migration; only actual stored editions may populate the eventual API date list.
- Future MongoDB session and rate-limit TTL fields are BSON Dates at storage boundaries; validate expiry on each protected request because TTL cleanup is asynchronous.
- Future identity credentials stay with the authentication provider and roles stay separate from profiles; the prepared MongoDB schemas are not an authentication implementation.
- mongodb's tr46 is patched (patches/) to require "punycode" instead of "punycode/"; the worker build cannot resolve the trailing-slash form.
- Sign-up runs only through a server function that creates an already-confirmed account; per-address counts live in a service-role-only table and sign-up is refused past the limit, so the app never sends auth emails (no confirmation, no password reset).
- Catalogue, article bodies and discussions are cached in memory per server isolate (stale-while-revalidate for the catalogue; community writes clear the discussion cache) because each MongoDB request must open its own connection on the edge runtime.
- When the catalogue is unavailable, story routes (/, /section, /article, /search, /explore) render only the DataUnavailable message; individual empty blocks use EmptyCard from src/components/states.tsx so layouts keep their shape.
- Like, save, share and comment actions update the query cache optimistically and roll back on error; active like/save fills only the icon.
- Data-backed tests load the live MongoDB catalogue in src/test/setup.ts when MONGODB_URI is set, so they assert rules rather than fixed sample stories.
- nitro.config.ts rewrites runtime require("node:*") into static imports in the server bundle; the deployed Worker cannot resolve Node built-ins via require(), which broke the MongoDB driver online.
- Broken or missing photos are swapped page-wide (src/lib/image-fallback.ts, installed in __root) for one of 20 fixed CSS gradients keyed by the image address, so no alt text or placeholder ever shows and a story keeps the same gradient everywhere.
- Direct children of the root .app-shell column are forced to full width (styles.css) because mx-auto blocks in a flex column shrink to their content and overflow phone screens.
- Sign-in is email and password only; social providers are disabled because community data must live in the app's own MongoDB.
- Database schema changes are recorded as SQL files in drizzle/migrations (applied through the Lovable migration tool); never edit applied files, add a new one.
- Request protection (probe/scanner blocking, per-visitor rate limits with escalating temporary bans, body/URL caps, security headers, cache headers) lives in src/lib/protection.ts and runs in src/server.ts before the app; it is per-isolate and complements the hosting edge flood protection.
- Story timestamps in MongoDB are ISO strings (the live articles validator is strict); mongodb/schema.json is JSON-Schema dialect, so translate const/exclusiveMinimum/format before collMod.
