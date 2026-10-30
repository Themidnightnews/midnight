# Move all user data and sign-in to MongoDB

Goal: the site runs with only `MONGODB_URI` and `COMMUNITY_ENCRYPTION_KEY` in `.env`. Lovable Cloud is no longer used by any page.

## What moves

| Today (Lovable Cloud) | After (MongoDB, db "midnight") |
|---|---|
| Reader sign-up / sign-in / sign-out | `users` + `userSessions` collections, own login |
| Sign-up limit per address | `signupAttempts` (auto-expires) |
| Admin accounts, sessions, activity log | `adminAccounts`, `adminSessions`, `adminAuditLog` |
| Site settings (maintenance, pause sign-ups/comments) | `siteSettings` (single document) |
| Page-view counts | `pageViews` |

## How sign-in will work
- Passwords stored as salted PBKDF2 hashes (built into the server runtime, no extra service).
- Signing in sets a secure, httpOnly cookie; each request checks the session in MongoDB (expiry checked on every request, old sessions auto-cleaned).
- Same rules as now: instant accounts, no emails sent, per-address sign-up limit, idle sign-out, "sign out everywhere".
- Reader emails stay encrypted with `COMMUNITY_ENCRYPTION_KEY`; a hashed copy is used for lookup.
- Admin login keeps its separate cookie; a first admin is created from `.env` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`) if none exists, replacing the old admin/admin default.

## Effects to know
- Existing reader accounts in Lovable Cloud are not copied (passwords cannot be exported); readers sign up again. Community data was already wiped, so nothing is lost there.
- Old page-view counts and admin log stay behind unless you want them copied once.

## Technical details
- New `src/lib/auth.server.ts` (hash, sessions, `currentUser`) and `auth.functions.ts` (signUp, signIn, signOut, me); `use-auth.tsx` reads `me` via React Query instead of the Supabase client.
- Replace `requireSupabaseAuth` / `context.userId` in community and profile functions with `requireUser()`; `_authenticated` guard uses `me`.
- `admin.server.ts`, `admin.functions.ts`, `signup.functions.ts`, `site-tracking.ts` rewritten on MongoDB; Postgres RPCs (`admin_view_stats`, `admin_check_password`, `account_login_status`) reimplemented as aggregation/code.
- Remove `attachSupabaseAuth` from `src/start.ts`; no imports of `@/integrations/supabase` remain in app code.
- Add validators and indexes (unique email hash/username, TTL on sessions and attempts) to `src/lib/mongodb`, regenerate `mongodb/schema.json`, apply to the live db.
- Update `.env.example`, AGENTS.md; update tests and verify sign-up, sign-in, comment, admin login end-to-end with Playwright.
