CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE IF NOT EXISTS public.signup_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ip_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS signup_attempts_ip_idx ON public.signup_attempts (ip_hash, created_at);
GRANT ALL ON public.signup_attempts TO service_role;
ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.account_login_status(_email text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN u.id IS NULL THEN 'no_account'
    WHEN u.encrypted_password IS NULL OR u.encrypted_password = '' THEN 'social_only'
    WHEN u.email_confirmed_at IS NULL THEN 'unconfirmed'
    ELSE 'has_password'
  END
  FROM (SELECT 1) x
  LEFT JOIN auth.users u ON lower(u.email) = lower(_email);
$$;
REVOKE ALL ON FUNCTION public.account_login_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_login_status(text) TO service_role;
CREATE TABLE IF NOT EXISTS public.admin_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL, email text NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor')), disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_username_idx ON public.admin_accounts (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_idx ON public.admin_accounts (lower(email));
GRANT ALL ON public.admin_accounts TO service_role;
ALTER TABLE public.admin_accounts ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.admin_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.admin_accounts(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, ip_hash text, user_agent text, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE INDEX IF NOT EXISTS admin_sessions_account_idx ON public.admin_sessions (account_id);
GRANT ALL ON public.admin_sessions TO service_role;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.admin_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, username text, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, ip_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON public.admin_audit_log (created_at DESC);
GRANT ALL ON public.admin_audit_log TO service_role;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.page_views (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), path text NOT NULL, article_slug text, referrer text, visitor_id text NOT NULL, device text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS page_views_created_idx ON public.page_views (created_at DESC);
CREATE INDEX IF NOT EXISTS page_views_article_idx ON public.page_views (article_slug, created_at DESC);
GRANT INSERT ON public.page_views TO anon, authenticated;
GRANT ALL ON public.page_views TO service_role;
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can record a page view" ON public.page_views;
CREATE POLICY "Anyone can record a page view" ON public.page_views FOR INSERT TO anon, authenticated
  WITH CHECK (length(path) BETWEEN 1 AND 500 AND (article_slug IS NULL OR length(article_slug) <= 300) AND (referrer IS NULL OR length(referrer) <= 500) AND length(visitor_id) BETWEEN 8 AND 64 AND (device IS NULL OR device IN ('mobile','tablet','desktop')) AND path NOT LIKE '/admin%');
CREATE TABLE IF NOT EXISTS public.site_settings (id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), maintenance_mode boolean NOT NULL DEFAULT false, maintenance_message text NOT NULL DEFAULT 'We are making a few improvements. Please check back shortly.', signups_enabled boolean NOT NULL DEFAULT true, comments_enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.site_settings TO anon, authenticated;
GRANT ALL ON public.site_settings TO service_role;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Site settings are public" ON public.site_settings;
CREATE POLICY "Site settings are public" ON public.site_settings FOR SELECT TO anon, authenticated USING (true);
INSERT INTO public.site_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.admin_check_password(_login text, _password text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT id FROM public.admin_accounts WHERE (lower(username) = lower(_login) OR lower(email) = lower(_login)) AND NOT disabled AND password_hash = extensions.crypt(_password, password_hash) LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.admin_hash_password(_password text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT extensions.crypt(_password, extensions.gen_salt('bf', 10));
$$;
REVOKE ALL ON FUNCTION public.admin_check_password(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_hash_password(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_check_password(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_hash_password(text) TO service_role;
CREATE OR REPLACE FUNCTION public.admin_view_stats(_days integer, _slug text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT * FROM public.page_views WHERE created_at >= now() - make_interval(days => greatest(1, least(_days, 365))) AND (_slug IS NULL OR article_slug = _slug))
  SELECT jsonb_build_object(
    'views', (SELECT count(*) FROM v),
    'visitors', (SELECT count(DISTINCT visitor_id) FROM v),
    'today', (SELECT count(*) FROM v WHERE created_at >= date_trunc('day', now())),
    'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'views', n, 'visitors', u) ORDER BY d) FROM (SELECT date_trunc('day', created_at)::date AS d, count(*) AS n, count(DISTINCT visitor_id) AS u FROM v GROUP BY 1) s), '[]'::jsonb),
    'paths', COALESCE((SELECT jsonb_agg(jsonb_build_object('path', path, 'views', n, 'visitors', u) ORDER BY n DESC) FROM (SELECT path, count(*) AS n, count(DISTINCT visitor_id) AS u FROM v GROUP BY path ORDER BY count(*) DESC LIMIT 50) s), '[]'::jsonb),
    'articles', COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', article_slug, 'views', n, 'visitors', u) ORDER BY n DESC) FROM (SELECT article_slug, count(*) AS n, count(DISTINCT visitor_id) AS u FROM v WHERE article_slug IS NOT NULL GROUP BY article_slug ORDER BY count(*) DESC LIMIT 200) s), '[]'::jsonb),
    'referrers', COALESCE((SELECT jsonb_agg(jsonb_build_object('referrer', r, 'views', n) ORDER BY n DESC) FROM (SELECT COALESCE(NULLIF(referrer, ''), 'Direct') AS r, count(*) AS n FROM v GROUP BY 1 ORDER BY count(*) DESC LIMIT 20) s), '[]'::jsonb),
    'devices', COALESCE((SELECT jsonb_agg(jsonb_build_object('device', COALESCE(device, 'unknown'), 'views', n)) FROM (SELECT device, count(*) AS n FROM v GROUP BY device) s), '[]'::jsonb),
    'hours', COALESCE((SELECT jsonb_agg(jsonb_build_object('hour', h, 'views', n) ORDER BY h) FROM (SELECT extract(hour FROM created_at)::int AS h, count(*) AS n FROM v GROUP BY 1) s), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.admin_view_stats(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_view_stats(integer, text) TO service_role;
INSERT INTO public.admin_accounts (username, email, password_hash, role)
SELECT 'admin', 'admin@themidnightnews.com', extensions.crypt('admin', extensions.gen_salt('bf', 10)), 'admin'
WHERE NOT EXISTS (SELECT 1 FROM public.admin_accounts);