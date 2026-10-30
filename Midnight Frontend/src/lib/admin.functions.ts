import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { escapeRegex, pageInput, queryWords, sinceDate, slicePage, toPage } from "./admin-paging";

const srv = () => import("./admin.server");
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

/* ---------- Session ---------- */

export const adminMe = createServerFn({ method: "GET" }).handler(async () => {
  const { currentAdmin } = await srv();
  const me = await currentAdmin();
  return me ? { id: me.id, username: me.username, email: me.email, role: me.role } : null;
});

export const adminLogin = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { adminDb, ipHash, audit, createSession } = await srv();
    const db = await adminDb();
    const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
    const { count } = await db.from("admin_audit_log").select("id", { count: "exact", head: true })
      .eq("action", "login_failed").eq("ip_hash", await ipHash()).gte("created_at", since);
    if ((count ?? 0) >= MAX_FAILED_LOGINS) {
      return { ok: false as const, error: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` };
    }
    const { data: id } = await db.rpc("admin_check_password", { _login: data.login, _password: data.password });
    if (!id) {
      await audit(null, "login_failed", { login: data.login.slice(0, 80) });
      return { ok: false as const, error: "Wrong username or password." };
    }
    const { data: acc } = await db.from("admin_accounts").select("id, username").eq("id", id).single();
    await db.from("admin_accounts").update({ last_login_at: new Date().toISOString() }).eq("id", id);
    await createSession(id);
    await audit(acc, "login");
    return { ok: true as const };
  });

export const adminLogout = createServerFn({ method: "POST" }).handler(async () => {
  const { endSession, currentAdmin, audit } = await srv();
  const me = await currentAdmin();
  await endSession();
  if (me) await audit(me, "logout");
  return { ok: true };
});

/* ---------- Analytics ---------- */

type Stats = {
  views: number; visitors: number; today: number;
  daily: { day: string; views: number; visitors: number }[];
  paths: { path: string; views: number; visitors: number }[];
  articles: { slug: string; views: number; visitors: number }[];
  referrers: { referrer: string; views: number }[];
  devices: { device: string; views: number }[];
  hours: { hour: number; views: number }[];
};

export const adminStats = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ days: z.number().int().min(1).max(365), slug: z.string().max(300).nullable().optional() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb } = await srv();
    await requireAdmin("editor");
    const db = await adminDb();
    const { data: s, error } = await db.rpc("admin_view_stats", data.slug ? { _days: data.days, _slug: data.slug } : { _days: data.days });
    if (error) throw new Error("Could not load visit numbers");
    return s as unknown as Stats;
  });

export const adminOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin, adminDb, loadSettings } = await srv();
  const me = await requireAdmin("editor");
  const db = await adminDb();
  const { withDb } = await import("./community.server");
  const [stats, settings, failed, mongo, members] = await Promise.all([
    db.rpc("admin_view_stats", { _days: 30 }).then((r) => r.data as unknown as Stats),
    loadSettings(),
    db.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("action", "login_failed")
      .gte("created_at", new Date(Date.now() - 86_400_000).toISOString()).then((r) => r.count ?? 0),
    withDb(async (m) => {
      const [published, paused, comments, commentsToday, readers] = await Promise.all([
        m.collection("articles").countDocuments({ status: "published" }),
        m.collection("articles").countDocuments({ status: "paused" }),
        m.collection("communityComments").countDocuments({ deletedAt: null }),
        m.collection("communityComments").countDocuments({ createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
        m.collection("communityProfiles").countDocuments({}),
      ]);
      return { published, paused, comments, commentsToday, readers };
    }).catch(() => null),
    me.role === "admin" ? db.auth.admin.listUsers({ page: 1, perPage: 1 }).then((r) => (r.data as { total?: number })?.total ?? null).catch(() => null) : Promise.resolve(null),
  ]);
  return { stats, settings, failedLogins24h: failed, mongo, members };
});

export const adminCommunityTotals = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await srv();
  await requireAdmin("editor");
  const { withDb } = await import("./community.server");
  return withDb(async (m) => {
    const [published, paused, comments, replies, likes, saves, shares, commentLikes, readers] = await Promise.all([
      m.collection("articles").countDocuments({ status: { $ne: "paused" } }),
      m.collection("articles").countDocuments({ status: "paused" }),
      m.collection("communityComments").countDocuments({ deletedAt: null, parentId: null }),
      m.collection("communityComments").countDocuments({ deletedAt: null, parentId: { $ne: null } }),
      m.collection("communityInteractions").countDocuments({ kind: "like" }),
      m.collection("communityInteractions").countDocuments({ kind: "save" }),
      m.collection("communityShares").countDocuments({}),
      m.collection("communityCommentLikes").countDocuments({}),
      m.collection("communityProfiles").countDocuments({}),
    ]);
    return { published, paused, comments, replies, likes, saves, shares, commentLikes, readers };
  });
});

/* ---------- Articles (MongoDB) ---------- */

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function clearCaches() {
  const { resetCatalogueCache } = await import("./catalogue.server");
  resetCatalogueCache();
}

export const adminListArticles = createServerFn({ method: "GET" })
  .inputValidator((d) => pageInput.extend({
    section: z.string().max(100).default("all"),
    status: z.enum(["all", "published", "paused"]).default("all"),
    featured: z.enum(["all", "featured", "regular"]).default("all"),
  }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb } = await srv();
    await requireAdmin("editor");
    const { withDb } = await import("./community.server");
    const db = await adminDb();
    const and: Record<string, unknown>[] = [];
    for (const w of queryWords(data.q)) { const rx = { $regex: escapeRegex(w), $options: "i" }; and.push({ $or: [{ title: rx }, { slug: rx }, { section: rx }] }); }
    const since = sinceDate(data.days);
    if (since) and.push({ $or: [{ publishedAt: { $gte: since } }, { publishedAt: { $gte: since.toISOString() } }] });
    if (data.section !== "all") and.push({ section: data.section });
    if (data.status === "paused") and.push({ status: "paused" }); else if (data.status === "published") and.push({ status: { $ne: "paused" } });
    if (data.featured !== "all") and.push(data.featured === "featured" ? { featured: true } : { featured: { $ne: true } });
    const filter = and.length ? { $and: and } : {};
    const [{ docs, total, sections }, stats] = await Promise.all([
      withDb(async (m) => {
        const col = m.collection("articles");
        const [docs, total, sections] = await Promise.all([
          col.find(filter, { projection: { slug: 1, title: 1, section: 1, status: 1, publishedAt: 1, featured: 1, img: 1 } }).sort({ publishedAt: -1, slug: 1 }).skip(data.offset).limit(data.limit).toArray(),
          col.countDocuments(filter),
          data.offset === 0 ? col.distinct("section") : Promise.resolve(null),
        ]);
        return { docs, total, sections: sections ? (sections as unknown[]).filter((x): x is string => typeof x === "string" && !!x).sort() : null };
      }),
      db.rpc("admin_view_stats", { _days: 365 }).then((r) => r.data as unknown as Stats),
    ]);
    const views = new Map(stats.articles.map((a) => [a.slug, a]));
    const rows = docs.map((d) => ({
      slug: str(d["slug"]), title: str(d["title"]), section: str(d["section"]), status: str(d["status"]) || "published",
      featured: d["featured"] === true, img: str(d["img"]),
      publishedAt: d["publishedAt"] instanceof Date ? d["publishedAt"].toISOString() : str(d["publishedAt"]),
      views: views.get(str(d["slug"]))?.views ?? 0, visitors: views.get(str(d["slug"]))?.visitors ?? 0,
    }));
    return { ...toPage(rows, total, data.offset), sections };
  });

export const adminGetArticle = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(300) }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await srv();
    await requireAdmin("editor");
    const { withDb } = await import("./community.server");
    const d = await withDb((m) => m.collection("articles").findOne({ slug: data.slug }));
    if (!d) return null;
    return {
      slug: str(d["slug"]), title: str(d["title"]), subtitle: str(d["subtitle"]), excerpt: str(d["excerpt"]),
      body: strs(d["body"]), summary: strs(d["summary"]), section: str(d["section"]), tag: str(d["tag"]),
      img: str(d["img"]), imageAlt: str(d["imageAlt"]), featured: d["featured"] === true,
      headlineWeight: typeof d["headlineWeight"] === "number" ? d["headlineWeight"] : 0,
      status: str(d["status"]) || "published",
    };
  });

const articleInput = z.object({
  slug: z.string().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500),
  excerpt: z.string().max(1000),
  body: z.array(z.string().max(20000)).max(400),
  summary: z.array(z.string().max(2000)).max(20),
  section: z.string().max(100),
  tag: z.string().max(100),
  img: z.string().max(2000),
  imageAlt: z.string().max(300),
  featured: z.boolean(),
  headlineWeight: z.number().min(0).max(100),
});

export const adminSaveArticle = createServerFn({ method: "POST" })
  .inputValidator((d) => articleInput.parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, audit } = await srv();
    const me = await requireAdmin("editor");
    const { withDb } = await import("./community.server");
    const { slug, ...fields } = data;
    const r = await withDb(async (m) => {
      const col = m.collection("articles");
      const prev = await col.findOne({ slug }, { projection: { section: 1, sections: 1 } });
      if (!prev) return { matchedCount: 0 };
      const extra: Record<string, unknown> = {};
      if (str(prev["section"]) !== fields.section) {
        const old = Array.isArray(prev["sections"]) ? (prev["sections"] as unknown[]).filter((x): x is string => typeof x === "string") : [str(prev["section"])];
        extra["sections"] = [fields.section, ...old.filter((s) => s && s !== fields.section)].slice(0, 3);
      }
      return col.updateOne({ slug }, { $set: { ...fields, ...extra, body: fields.body.filter((p) => p.trim()), summary: fields.summary.filter((p) => p.trim()), updatedAt: new Date().toISOString() } });
    });
    if (!r.matchedCount) throw new Error("That story no longer exists");
    await clearCaches();
    await audit(me, "article_edited", { slug });
    return { ok: true };
  });

export const adminSetArticleStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(300), status: z.enum(["published", "paused"]) }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, audit } = await srv();
    const me = await requireAdmin("editor");
    const { withDb } = await import("./community.server");
    await withDb((m) => m.collection("articles").updateOne({ slug: data.slug }, { $set: { status: data.status, updatedAt: new Date().toISOString() } }));
    await clearCaches();
    await audit(me, data.status === "paused" ? "article_paused" : "article_published", { slug: data.slug });
    return { ok: true };
  });

/* ---------- Comments ---------- */

/** Finds reader ids and story slugs whose name or title contains every typed word (comment text is encrypted, so it can't be searched). */
async function matchPeopleAndStories(m: import("mongodb").Db, q: string) {
  const words = queryWords(q);
  if (!words.length) return null;
  const all = (field: string) => ({ $and: words.map((w) => ({ [field]: { $regex: escapeRegex(w), $options: "i" } })) });
  const [people, stories] = await Promise.all([
    m.collection<{ _id: string }>("communityProfiles").find(all("username"), { projection: { _id: 1 } }).limit(500).toArray(),
    m.collection("articles").find({ $or: [all("title"), all("slug")] }, { projection: { slug: 1 } }).limit(500).toArray(),
  ]);
  return { userIds: people.map((p) => String(p._id)), slugs: stories.map((a) => str(a["slug"])) };
}

export const adminListComments = createServerFn({ method: "GET" })
  .inputValidator((d) => pageInput.extend({ kind: z.enum(["all", "comment", "reply"]).default("all"), story: z.string().max(300).default("all") }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await srv();
    await requireAdmin("editor");
    const { withDb, decrypt } = await import("./community.server");
    return withDb(async (m) => {
      const filter: Record<string, unknown> = { deletedAt: null };
      if (data.kind !== "all") filter["parentId"] = data.kind === "reply" ? { $ne: null } : null;
      if (data.story !== "all") filter["articleSlug"] = data.story;
      const since = sinceDate(data.days);
      if (since) filter["createdAt"] = { $gte: since };
      const match = await matchPeopleAndStories(m, data.q);
      if (match) filter["$or"] = [{ userId: { $in: match.userIds } }, { articleSlug: { $in: match.slugs } }];
      const col = m.collection("communityComments");
      const [raw, total, storySlugs] = await Promise.all([
        col.find(filter).sort({ createdAt: -1 }).skip(data.offset).limit(data.limit).toArray(),
        col.countDocuments(filter),
        data.offset === 0 ? col.distinct("articleSlug", { deletedAt: null }) : Promise.resolve(null),
      ]);
      const slugs = [...new Set([...raw.map((c) => str(c["articleSlug"])), ...((storySlugs as string[] | null) ?? [])])];
      const [profiles, arts] = await Promise.all([
        m.collection<{ _id: string; username: string }>("communityProfiles").find({ _id: { $in: [...new Set(raw.map((c) => String(c["userId"])))] } }).toArray(),
        m.collection("articles").find({ slug: { $in: slugs } }, { projection: { slug: 1, title: 1, img: 1 } }).toArray(),
      ]);
      const names = new Map(profiles.map((p) => [p._id, p.username]));
      const artMap = new Map(arts.map((a) => [str(a["slug"]), { title: str(a["title"]), img: str(a["img"]) }]));
      const rows = await Promise.all(raw.map(async (c) => ({
        id: String(c._id), articleSlug: str(c["articleSlug"]),
        articleTitle: artMap.get(str(c["articleSlug"]))?.title || str(c["articleSlug"]), img: artMap.get(str(c["articleSlug"]))?.img ?? "", text: await decrypt(c["textEnc"] as string | null),
        author: names.get(String(c["userId"])) ?? "former_reader", createdAt: (c["createdAt"] as Date).toISOString(), isReply: !!c["parentId"],
      })));
      const stories = storySlugs ? (storySlugs as string[]).map((slug) => ({ value: slug, label: artMap.get(slug)?.title || slug })).sort((a, b) => a.label.localeCompare(b.label)) : null;
      return { ...toPage(rows, total, data.offset), stories };
    });
  });

export const adminRemoveComment = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, audit } = await srv();
    const me = await requireAdmin("editor");
    const { withDb } = await import("./community.server");
    const { ObjectId } = await import("mongodb");
    await withDb((m) => m.collection("communityComments").updateOne({ _id: new ObjectId(data.id) }, { $set: { deletedAt: new Date(), textEnc: null } }));
    const { clearDiscussionCache } = await import("./community.functions");
    clearDiscussionCache();
    await audit(me, "comment_removed", { id: data.id });
    return { ok: true };
  });

/* ---------- Readers (MongoDB profiles joined with sign-in accounts) ---------- */

export type ReaderRow = {
  id: string; username: string; email: string; joinedAt: string; lastSignIn: string | null;
  comments: number; replies: number; likes: number; saves: number; likesReceived: number; account: "active" | "blocked" | "not_moved";
};

/** Every reader with their counts, kept for one minute per server so scrolling through batches doesn't recount everything. */
let readerCache: { at: number; rows: Promise<ReaderRow[]> } | null = null;
export function clearReaderCache() { readerCache = null; }
function allReaders() {
  if (!readerCache || Date.now() - readerCache.at > 60_000) {
    const rows = loadAllReaders();
    readerCache = { at: Date.now(), rows };
    rows.catch(() => { readerCache = null; });
  }
  return readerCache.rows;
}

async function loadAllReaders(): Promise<ReaderRow[]> {
  const { adminDb } = await srv();
  const db = await adminDb();
  const { withDb } = await import("./community.server");
  type Agg = { _id: string; n: number };
  const [profiles, counts, replyCounts, inter, received] = await withDb(async (m) => Promise.all([
    m.collection<{ _id: string; username: string; createdAt: Date }>("communityProfiles").find({}, { projection: { username: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(10000).toArray(),
    m.collection("communityComments").aggregate<Agg>([{ $match: { deletedAt: null, parentId: null } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray(),
    m.collection("communityComments").aggregate<Agg>([{ $match: { deletedAt: null, parentId: { $ne: null } } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray(),
    m.collection("communityInteractions").aggregate<{ _id: { u: string; k: string }; n: number }>([{ $group: { _id: { u: "$userId", k: "$kind" }, n: { $sum: 1 } } }]).toArray(),
    m.collection("communityCommentLikes").aggregate<Agg>([{ $group: { _id: "$authorId", n: { $sum: 1 } } }]).toArray(),
  ]));
  const map = (a: Agg[]) => new Map(a.map((c) => [String(c._id), c.n]));
  const rc = map(replyCounts), rec = map(received);
  const likeM = new Map<string, number>(), saveM = new Map<string, number>();
  for (const i of inter) (i._id.k === "like" ? likeM : i._id.k === "save" ? saveM : new Map()).set(String(i._id.u), i.n);
  const extra = (id: string) => ({ replies: rc.get(id) ?? 0, likes: likeM.get(id) ?? 0, saves: saveM.get(id) ?? 0, likesReceived: rec.get(id) ?? 0 });
  const users = new Map<string, { email: string; created: string; last: string | null; banned: boolean; username: string }>();
  for (let page = 1; page <= 20; page++) {
    const { data: res, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Could not load reader accounts");
    for (const u of res.users) {
      const until = (u as { banned_until?: string | null }).banned_until;
      users.set(u.id, { email: u.email ?? "", created: u.created_at, last: u.last_sign_in_at ?? null, banned: !!until && new Date(until) > new Date(), username: (u.user_metadata?.["username"] as string | undefined) ?? "" });
    }
    if (res.users.length < 1000) break;
  }
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  const rows: ReaderRow[] = profiles.map((p) => {
    const u = users.get(String(p._id));
    users.delete(String(p._id));
    return {
      id: String(p._id), username: p.username, email: u?.email ?? "", joinedAt: (p.createdAt instanceof Date ? p.createdAt : new Date()).toISOString(),
      lastSignIn: u?.last ?? null, comments: n.get(String(p._id)) ?? 0, ...extra(String(p._id)), account: !u ? "not_moved" : u.banned ? "blocked" : "active",
    };
  });
  // Accounts that signed up but never opened their profile yet.
  for (const [id, u] of users) rows.push({ id, username: u.username || u.email.split("@")[0] || "reader", email: u.email, joinedAt: u.created, lastSignIn: u.last, comments: 0, ...extra(id), account: u.banned ? "blocked" : "active" });
  return rows;
}

export const adminListReaders = createServerFn({ method: "GET" })
  .inputValidator((d) => pageInput.extend({
    account: z.enum(["all", "active", "blocked", "not_moved"]).default("all"),
    activity: z.enum(["all", "commented", "silent"]).default("all"),
    sort: z.enum(["newest", "oldest", "active", "comments", "replies", "likes", "saves", "likesReceived"]).default("newest"),
    fresh: z.boolean().default(false),
  }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await srv();
    await requireAdmin("admin");
    if (data.fresh && data.offset === 0) clearReaderCache();
    const all = await allReaders();
    const since = sinceDate(data.days);
    const words = queryWords(data.q);
    const sort = data.sort;
    const rows = all.filter((u) => {
      const hay = `${u.username} ${u.email}`.toLowerCase();
      return words.every((w) => hay.includes(w)) && (!since || Date.parse(u.joinedAt) >= since.getTime()) &&
        (data.account === "all" || u.account === data.account) && (data.activity === "all" || (data.activity === "commented") === (u.comments + u.replies) > 0);
    }).sort((a, b) => sort === "newest" ? b.joinedAt.localeCompare(a.joinedAt) : sort === "oldest" ? a.joinedAt.localeCompare(b.joinedAt) : sort === "active" ? (b.lastSignIn ?? "").localeCompare(a.lastSignIn ?? "") : b[sort] - a[sort]);
    return { ...slicePage(rows, data.offset, data.limit), everyone: all.length, notMoved: all.filter((u) => u.account === "not_moved").length };
  });

export const adminSetMemberBlocked = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid(), blocked: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    const db = await adminDb();
    const { error } = await db.auth.admin.updateUserById(data.id, { ban_duration: data.blocked ? "876000h" : "none" });
    if (error) throw new Error(error.message);
    clearReaderCache();
    await audit(me, data.blocked ? "member_blocked" : "member_unblocked", { id: data.id });
    return { ok: true };
  });

export const adminDeleteMember = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    const db = await adminDb();
    const { error } = await db.auth.admin.deleteUser(data.id);
    if (error && !/not.?found/i.test(error.message)) throw new Error(error.message);
    const { withDb } = await import("./community.server");
    await withDb((m) => m.collection("communityProfiles").deleteOne({ _id: data.id as never }));
    clearReaderCache();
    await audit(me, "member_deleted", { id: data.id });
    return { ok: true };
  });

/* ---------- Security & site controls ---------- */

export const adminSecurity = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin, adminDb, loadSettings } = await srv();
  const me = await requireAdmin("admin");
  const db = await adminDb();
  const [settings, sessions] = await Promise.all([
    loadSettings(),
    db.from("admin_sessions").select("id, created_at, last_seen_at, expires_at, user_agent, admin_accounts!inner(username)")
      .is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("last_seen_at", { ascending: false }).limit(50).then((r) => r.data ?? []),
  ]);
  return {
    settings,
    currentSessionId: me.sessionId,
    sessions: sessions.map((s) => ({ id: s.id, createdAt: s.created_at, lastSeen: s.last_seen_at, expires: s.expires_at, device: s.user_agent ?? "", username: (s.admin_accounts as unknown as { username: string }).username })),
  };
});

/* ---------- Activity: what the team did, and what readers did ---------- */

export const ADMIN_ACTIONS = [
  "login", "login_failed", "logout", "article_edited", "article_paused", "article_published", "comment_removed",
  "member_blocked", "member_unblocked", "member_deleted", "settings_changed", "session_revoked", "all_sessions_revoked",
  "editor_added", "editor_updated", "editor_removed", "account_updated",
] as const;

export const adminActivityLog = createServerFn({ method: "GET" })
  .inputValidator((d) => pageInput.extend({ who: z.string().max(100).default("all"), action: z.string().max(60).default("all") }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb } = await srv();
    await requireAdmin("admin");
    const db = await adminDb();
    let query = db.from("admin_audit_log").select("id, username, action, detail, ip_hash, created_at", { count: "exact" });
    const since = sinceDate(data.days);
    if (since) query = query.gte("created_at", since.toISOString());
    if (data.who !== "all") query = data.who === "—" ? query.is("username", null) : query.eq("username", data.who);
    if (data.action !== "all") query = query.eq("action", data.action);
    for (const w of queryWords(data.q)) {
      const like = `%${w.replace(/[%_,()]/g, "")}%`;
      query = query.or(`username.ilike.${like},action.ilike.${like}`);
    }
    const [{ data: log, count, error }, people] = await Promise.all([
      query.order("created_at", { ascending: false }).range(data.offset, data.offset + data.limit - 1),
      data.offset === 0 ? db.from("admin_accounts").select("username").order("username").then((r) => (r.data ?? []).map((a) => a.username)) : Promise.resolve(null),
    ]);
    if (error) throw new Error("Could not load admin activity");
    const rows = (log ?? []).map((l) => ({ id: l.id, username: l.username, action: l.action, detail: JSON.stringify(l.detail ?? {}), network: (l.ip_hash ?? "").slice(0, 8), at: l.created_at }));
    return { ...toPage(rows, count ?? 0, data.offset), people, actions: data.offset === 0 ? [...ADMIN_ACTIONS] : null };
  });

export type ReaderActivityKind = "comment" | "reply" | "story_like" | "save" | "comment_like";

export const adminReaderActivity = createServerFn({ method: "GET" })
  .inputValidator((d) => pageInput.extend({ kind: z.enum(["all", "comment", "reply", "story_like", "save", "comment_like"]).default("all") }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin } = await srv();
    await requireAdmin("admin");
    const { withDb } = await import("./community.server");
    return withDb(async (m) => {
      const since = sinceDate(data.days);
      const match = await matchPeopleAndStories(m, data.q);
      const pipeline: Record<string, unknown>[] = [
        { $match: { deletedAt: null } },
        { $project: { _id: 0, id: { $toString: "$_id" }, userId: 1, articleSlug: 1, createdAt: 1, kind: { $cond: [{ $ifNull: ["$parentId", false] }, "reply", "comment"] } } },
        { $unionWith: { coll: "communityInteractions", pipeline: [{ $match: { kind: { $in: ["like", "save"] } } }, { $project: { _id: 0, id: { $toString: "$_id" }, userId: 1, articleSlug: 1, createdAt: 1, kind: { $cond: [{ $eq: ["$kind", "like"] }, "story_like", "save"] } } }] } },
        { $unionWith: { coll: "communityCommentLikes", pipeline: [{ $project: { _id: 0, id: { $toString: "$_id" }, userId: 1, commentId: 1, createdAt: 1, kind: "comment_like" } }] } },
      ];
      const after: Record<string, unknown> = {};
      if (data.kind !== "all") after["kind"] = data.kind;
      if (since) after["createdAt"] = { $gte: since };
      if (match) after["$or"] = [{ userId: { $in: match.userIds } }, { articleSlug: { $in: match.slugs } }];
      if (Object.keys(after).length) pipeline.push({ $match: after });
      const [res] = await m.collection("communityComments").aggregate<{ rows: { id: string; userId: string; articleSlug?: string; commentId?: string; createdAt: Date; kind: ReaderActivityKind }[]; total: { n: number }[] }>([
        ...pipeline,
        { $facet: { rows: [{ $sort: { createdAt: -1, id: -1 } }, { $skip: data.offset }, { $limit: data.limit }], total: [{ $count: "n" }] } },
      ]).toArray();
      const raw = res?.rows ?? [];
      // Comment likes point at a comment; find which story it belongs to.
      const { ObjectId } = await import("mongodb");
      const likedIds = raw.filter((r) => r.commentId && /^[a-f0-9]{24}$/.test(r.commentId)).map((r) => new ObjectId(r.commentId));
      const liked = likedIds.length ? await m.collection("communityComments").find({ _id: { $in: likedIds } }, { projection: { articleSlug: 1 } }).toArray() : [];
      const likedSlug = new Map(liked.map((c) => [String(c._id), str(c["articleSlug"])]));
      const slugOf = (r: (typeof raw)[number]) => r.articleSlug ?? (r.commentId ? likedSlug.get(r.commentId) ?? "" : "");
      const [profiles, arts] = await Promise.all([
        m.collection<{ _id: string; username: string }>("communityProfiles").find({ _id: { $in: [...new Set(raw.map((r) => String(r.userId)))] } }, { projection: { username: 1 } }).toArray(),
        m.collection("articles").find({ slug: { $in: [...new Set(raw.map(slugOf).filter(Boolean))] } }, { projection: { slug: 1, title: 1, img: 1 } }).toArray(),
      ]);
      const names = new Map(profiles.map((p) => [String(p._id), p.username]));
      const artMap = new Map(arts.map((a) => [str(a["slug"]), { title: str(a["title"]), img: str(a["img"]) }]));
      const rows = raw.map((r) => {
        const slug = slugOf(r);
        return { id: `${r.kind}-${r.id}`, kind: r.kind, reader: names.get(String(r.userId)) ?? "former_reader", articleSlug: slug, articleTitle: artMap.get(slug)?.title || slug, img: artMap.get(slug)?.img ?? "", at: r.createdAt instanceof Date ? r.createdAt.toISOString() : "" };
      });
      return toPage(rows, res?.total[0]?.n ?? 0, data.offset);
    });
  });

export const adminUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({
    maintenance_mode: z.boolean(), maintenance_message: z.string().trim().max(500),
    signups_enabled: z.boolean(), comments_enabled: z.boolean(),
  }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    const db = await adminDb();
    await db.from("site_settings").update({ ...data, updated_at: new Date().toISOString() }).eq("id", 1);
    await audit(me, "settings_changed", data);
    return { ok: true };
  });

export const adminRevokeSession = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid().nullable() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    const db = await adminDb();
    const now = new Date().toISOString();
    // null = sign out every other device
    if (data.id) await db.from("admin_sessions").update({ revoked_at: now }).eq("id", data.id);
    else await db.from("admin_sessions").update({ revoked_at: now }).is("revoked_at", null).neq("id", me.sessionId);
    await audit(me, data.id ? "session_revoked" : "all_sessions_revoked", {});
    return { ok: true };
  });

/* ---------- Team (admin accounts) ---------- */

export const adminListTeam = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin, adminDb } = await srv();
  await requireAdmin("admin");
  const db = await adminDb();
  const { data } = await db.from("admin_accounts").select("id, username, email, role, disabled, created_at, last_login_at").order("created_at");
  return data ?? [];
});

const pw = z.string().min(8, "Use at least 8 characters").max(200);

export const adminCreateEditor = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/), email: z.string().trim().email().max(254), password: pw }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    const db = await adminDb();
    const { data: hash } = await db.rpc("admin_hash_password", { _password: data.password });
    const { error } = await db.from("admin_accounts").insert({ username: data.username, email: data.email.toLowerCase(), password_hash: hash as string, role: "editor" });
    if (error) throw new Error(error.code === "23505" ? "That username or email is already used" : "Could not add this person");
    await audit(me, "editor_added", { username: data.username });
    return { ok: true };
  });

export const adminUpdateTeamMember = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid(), disabled: z.boolean().optional(), remove: z.boolean().optional(), password: pw.optional() }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("admin");
    if (data.id === me.id) throw new Error("Use My account to change your own login");
    const db = await adminDb();
    const { data: target } = await db.from("admin_accounts").select("username, role").eq("id", data.id).single();
    if (!target) throw new Error("Account not found");
    if (target.role === "admin" && (data.remove || data.disabled)) throw new Error("Full admin accounts cannot be removed here");
    if (data.remove) {
      await db.from("admin_accounts").delete().eq("id", data.id);
      await audit(me, "editor_removed", { username: target.username });
      return { ok: true };
    }
    if (data.disabled !== undefined) {
      await db.from("admin_accounts").update({ disabled: data.disabled }).eq("id", data.id);
      if (data.disabled) await db.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("account_id", data.id).is("revoked_at", null);
    }
    if (data.password) {
      const { data: hash } = await db.rpc("admin_hash_password", { _password: data.password });
      await db.from("admin_accounts").update({ password_hash: hash as string }).eq("id", data.id);
    }
    await audit(me, "editor_updated", { username: target.username, disabled: data.disabled, passwordReset: !!data.password });
    return { ok: true };
  });

export const adminUpdateMyAccount = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({
    username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_.-]+$/),
    email: z.string().trim().email().max(254),
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().max(200).optional(),
  }).parse(d))
  .handler(async ({ data }) => {
    const { requireAdmin, adminDb, audit } = await srv();
    const me = await requireAdmin("editor");
    const db = await adminDb();
    const { data: ok } = await db.rpc("admin_check_password", { _login: me.username, _password: data.currentPassword });
    if (ok !== me.id) return { ok: false as const, error: "Your current password is not right." };
    if (data.newPassword && data.newPassword.length < 8) return { ok: false as const, error: "A new password needs at least 8 characters." };
    const patch: { username: string; email: string; password_hash?: string } = { username: data.username, email: data.email.toLowerCase() };
    if (data.newPassword) patch.password_hash = (await db.rpc("admin_hash_password", { _password: data.newPassword })).data as string;
    const { error } = await db.from("admin_accounts").update(patch).eq("id", me.id);
    if (error) return { ok: false as const, error: error.code === "23505" ? "That username or email is already used." : "Could not save." };
    await audit(me, "account_updated", { username: data.username, passwordChanged: !!data.newPassword });
    return { ok: true as const };
  });

/* ---------- Public: site status for the maintenance screen ---------- */

export const getSiteStatus = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    const sb = createClient(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
    });
    const { data } = await sb.from("site_settings").select("maintenance_mode, maintenance_message, signups_enabled, comments_enabled").eq("id", 1).maybeSingle();
    return data ?? { maintenance_mode: false, maintenance_message: "", signups_enabled: true, comments_enabled: true };
  } catch {
    return { maintenance_mode: false, maintenance_message: "", signups_enabled: true, comments_enabled: true };
  }
});
