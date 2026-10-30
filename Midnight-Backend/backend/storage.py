"""
MongoDB storage. Articles are written straight to MongoDB the moment they are
created; nothing is kept in local files.

Collections used (names/shape from the Lovable project):
  articles      strict article documents (schema.py)
  sections      section definitions (seeded once, never overwritten)
Plus one collection of our own:
  ingestLedger  a record of EVERYTHING the pipeline touched: published,
                skipped duplicates, failures. Drives de-duplication.
"""

import math
import re
import threading
from datetime import datetime, timezone

from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError, PyMongoError

import config
from schema import SECTIONS, SECTION_BY_SLUG, load_sections, validate_article, now_iso, sanitize_html, \
    html_to_paragraphs, reading_minutes, slugify
from dedupe import normalise_url

MAX_FAILED_ATTEMPTS = 3

ARTICLE_INDEXES = [  # mirrors lovable/src/lib/mongodb/indexes.ts
    ("article_id", [("id", ASCENDING)], True),
    ("article_slug", [("slug", ASCENDING)], True),
    ("section_publication", [("status", ASCENDING), ("tag", ASCENDING), ("publishedAt", DESCENDING), ("slug", ASCENDING)], False),
    ("popular", [("status", ASCENDING), ("views", DESCENDING), ("slug", ASCENDING)], False),
    ("headlines", [("status", ASCENDING), ("featured", ASCENDING), ("headlineWeight", DESCENDING)], False),
    ("hashtags", [("status", ASCENDING), ("hashtags", ASCENDING)], False),
]


def _parse_dt(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _public(doc):
    if doc:
        doc.pop("_id", None)
    return doc


def _rx(text):
    return {"$regex": re.escape(text), "$options": "i"}


class MongoStorage:
    def __init__(self, client=None, db_name=None):
        self.client = client or MongoClient(config.get_mongo_uri(), serverSelectionTimeoutMS=15000)
        self.db = self.client[db_name or config.get_mongo_db_name()]
        self.articles = self.db["articles"]
        self.sections = self.db["sections"]
        self.ledger = self.db["ingestLedger"]
        self._lock = threading.Lock()

    # ------------------------------------------------------------ setup
    def ping(self):
        self.client.admin.command("ping")

    def ensure_ready(self):
        """Idempotent: creates missing indexes and inserts missing sections.
        Never modifies or deletes existing documents."""
        for name, keys, unique in ARTICLE_INDEXES:
            try:
                self.articles.create_index(keys, name=name, unique=unique)
            except PyMongoError as e:
                print(f"  ! index {name}: {str(e)[:100]} (left as-is)")
        try:
            self.sections.create_index([("slug", ASCENDING)], name="section_slug", unique=True)
            self.ledger.create_index([("normUrl", ASCENDING)], name="ledger_url", unique=True)
            self.ledger.create_index([("at", DESCENDING)], name="ledger_time")
        except PyMongoError as e:
            print(f"  ! index: {str(e)[:100]}")
        now = now_iso()
        if self.sections.count_documents({}) == 0:      # first run only: never re-add sections you removed
            for s in SECTIONS:
                doc = dict(s)
                doc["createdAt"] = doc.get("createdAt") or now
                doc["updatedAt"] = doc.get("updatedAt") or now
                self.sections.update_one({"slug": s["slug"]}, {"$setOnInsert": doc}, upsert=True)
        self.load_sections()

    def load_sections(self):
        """The live section list is whatever is in the database (the site uses the same list)."""
        try:
            return load_sections(list(self.sections.find({}, {"slug": 1, "name": 1, "desc": 1, "tags": 1})))
        except PyMongoError as e:
            print(f"  ! could not refresh sections, keeping the current list: {str(e)[:100]}")
            return len(SECTIONS)

    # ------------------------------------------------------- publishing
    def publish_article(self, article: dict) -> dict:
        """Validate, then insert into MongoDB immediately. Retries with a
        unique slug if two titles collide."""
        validate_article(article)
        with self._lock:
            for attempt in range(4):
                try:
                    self.articles.insert_one(dict(article))
                    return article
                except DuplicateKeyError as e:
                    if "article_slug" in str(e) or "slug" in str(e):
                        article["slug"] = f"{article['slug'][:80]}-{article['id'][-6:]}" if attempt == 0 \
                            else f"{article['slug'][:70]}-{article['id'][-6:]}-{attempt}"
                        continue
                    raise
        raise RuntimeError("could not find a unique slug")

    # ----------------------------------------------------------- ledger
    def record(self, *, source_name, source_url, source_title, section, status,
               reason=None, article_id=None, title=None):
        """Upsert a ledger entry. status: published | skipped | failed."""
        norm = normalise_url(source_url)
        now = now_iso()
        fields = {"sourceName": source_name, "sourceUrl": source_url, "sourceTitle": source_title,
                  "section": section, "status": status, "reason": reason,
                  "articleId": article_id, "articleTitle": title, "at": now}
        update = {"$set": fields, "$setOnInsert": {"normUrl": norm, "firstSeenAt": now}}
        if status == "failed":
            update["$inc"] = {"attempts": 1}
        self.ledger.update_one({"normUrl": norm}, update, upsert=True)

    def load_seen(self, seen, limit=5000):
        """Seeds a dedupe.SeenIndex with everything already covered."""
        for e in self.ledger.find({}).sort("at", DESCENDING).limit(limit):
            if e.get("status") == "failed" and e.get("attempts", 0) < MAX_FAILED_ATTEMPTS:
                continue  # transient failure: allowed to be retried
            seen.add(e.get("sourceUrl"), e.get("sourceTitle"), e.get("articleTitle"), ref=e.get("articleId"))
        for a in self.articles.find({}, {"title": 1, "source_url": 1, "id": 1}).sort("publishedAt", DESCENDING).limit(limit):
            seen.add(a.get("source_url"), a.get("title"), ref=a.get("id"))
        return seen

    def ledger_summary(self):
        out = {}
        for r in self.ledger.aggregate([{"$group": {"_id": "$status", "n": {"$sum": 1}}}]):
            out[r["_id"]] = r["n"]
        return out

    def recent_ledger(self, limit=50):
        return [_public(e) for e in self.ledger.find({}).sort("at", DESCENDING).limit(limit)]

    # -------------------------------------------------------- dashboard
    def source_stats(self):
        """Per-source counts from the ledger: {source: {published, skipped, failed, lastAt}}."""
        out = {}
        for r in self.ledger.aggregate([{"$group": {"_id": {"s": "$sourceName", "st": "$status"},
                                                    "n": {"$sum": 1}, "last": {"$max": "$at"}}}]):
            d = out.setdefault(r["_id"]["s"], {"published": 0, "skipped": 0, "failed": 0, "lastAt": None})
            d[r["_id"]["st"]] = r["n"]
            if not d["lastAt"] or (r["last"] and r["last"] > d["lastAt"]):
                d["lastAt"] = r["last"]
        return out

    def section_counts(self):
        return {r["_id"]: r["n"] for r in self.articles.aggregate(
            [{"$match": {"status": "published"}}, {"$group": {"_id": "$section", "n": {"$sum": 1}}}])}

    def list_reports(self, limit=60):
        return [_public(d) for d in self.db["reports"].find({}).sort("date", DESCENDING).limit(limit)]

    def get_report(self, date):
        return _public(self.db["reports"].find_one({"date": date}))

    # ------------------------------------------------------------- reads
    def _filter(self, category=None, hashtag=None, search=None):
        f = {"status": "published"}
        ands = []
        if category:
            ands.append({"$or": [{"section": slugify(category)}, {"sections": slugify(category)}, {"tag": _rx_exact(category)},
                                 {"category": _rx_exact(category)}]})
        if hashtag:
            ands.append({"hashtags": _rx_exact("#" + hashtag.lstrip("#"))})
        if search and search.strip():
            q = _rx(search.strip())
            ands.append({"$or": [{"title": q}, {"tag": q}, {"desk": q}, {"excerpt": q}]})
        if ands:
            f["$and"] = ands
        return f

    def list_posts(self, category=None, hashtag=None, search=None, sort="newest",
                   offset=0, limit=None):
        f = self._filter(category, hashtag, search)
        total = self.articles.count_documents(f)
        if sort in ("trending", "viral"):
            # Ranked in Python over the most recent window (views/min needs "now").
            docs = list(self.articles.find(f).sort([("publishedAt", DESCENDING), ("slug", ASCENDING)]).limit(1000))
            now = datetime.now(timezone.utc)

            def score(d):
                dt = _parse_dt(d.get("publishedAt") or "") or now
                mins = max((now - dt).total_seconds() / 60.0, 1.0)
                v = d.get("views") or 0
                return v / mins if sort == "viral" else v / math.pow(mins / 60.0 + 2, 1.5)
            docs.sort(key=lambda d: (score(d), d.get("publishedAt") or ""), reverse=True)
            docs = docs[offset: offset + limit] if limit is not None else docs[offset:]
            return [_public(d) for d in docs], total

        order = {"oldest": [("publishedAt", ASCENDING), ("slug", ASCENDING)],
                 "created": [("createdAt", DESCENDING), ("slug", ASCENDING)],    # dashboard: when WE published it

                 "popular": [("views", DESCENDING), ("slug", ASCENDING)]}.get(
            sort, [("publishedAt", DESCENDING), ("slug", ASCENDING)])
        cur = self.articles.find(f).sort(order).skip(max(offset, 0))
        if limit is not None:
            cur = cur.limit(limit)
        return [_public(d) for d in cur], total

    def get_post(self, key: str):
        """By stable id (art_...) or by slug."""
        return _public(self.articles.find_one({"$or": [{"id": key}, {"slug": key}], "status": "published"}))

    def all_hashtags(self):
        return sorted(t for t in self.articles.distinct("hashtags", {"status": "published"}) if t)

    def category_names(self):
        return [s["name"] for s in SECTIONS]

    # ------------------------------------------------------------ writes
    def increment_views(self, key: str):
        """Atomic. views starts as null (unknown); the first real view makes it
        a measured number."""
        match = {"$or": [{"id": key}, {"slug": key}]}
        for _ in range(3):
            r = self.articles.find_one_and_update(
                {**match, "views": {"$type": "number"}}, {"$inc": {"views": 1}}, return_document=True)
            if not r:
                r = self.articles.find_one_and_update(
                    {**match, "views": None},
                    {"$set": {"views": 1, "provenance.engagement": "measured"}}, return_document=True)
            if r:
                return r["views"]
            if not self.articles.find_one(match, {"id": 1}):
                return None
        return None

    def update_post(self, key: str, updates: dict):
        """Editable: title, excerpt, html_body, hashtags, category(tag), img."""
        cur = self.articles.find_one({"$or": [{"id": key}, {"slug": key}]})
        if not cur:
            return None
        new = {}
        for f in ("title", "excerpt", "hashtags", "img"):
            if f in updates and updates[f] is not None:
                new[f] = updates[f]
        if "img" in new:
            new["imageAlt"] = new.get("title", cur["title"])
        if "html_body" in updates and updates["html_body"]:
            html = sanitize_html(updates["html_body"])
            body = html_to_paragraphs(html)
            mins = reading_minutes(body)
            new.update(html_body=html, body=body, readingMinutes=mins, time=f"{mins} min",
                       subtitle=f"{cur['tag']} · {mins} min read")
        new["updatedAt"] = now_iso()
        merged = {**{k: v for k, v in cur.items() if k != "_id"}, **new}
        validate_article(merged)
        self.articles.update_one({"_id": cur["_id"]}, {"$set": new})
        return _public(self.articles.find_one({"_id": cur["_id"]}))


def _rx_exact(text):
    return {"$regex": f"^{re.escape(text)}$", "$options": "i"}


_instance = None


def get_storage():
    """Lazy singleton so importing this module never needs a live database."""
    global _instance
    if _instance is None:
        _instance = MongoStorage()
        _instance.ensure_ready()
    return _instance
