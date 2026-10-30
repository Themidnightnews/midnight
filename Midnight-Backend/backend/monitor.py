"""
Live monitoring. The pipeline (a separate process from the API) writes what
it is doing to MongoDB, and the dashboard reads it:

  ingestEvents   one document per action (visit, skip, write, publish, fail,
                 key switch, pause, report...). Expires after 14 days.
  systemState    one document, _id "generator": current status, heartbeat,
                 key health, current source, counters.
"""

import os
import threading
from datetime import datetime, timezone, timedelta

from schema import now_iso

KEEP_DAYS = 14


class Monitor:
    def __init__(self, db):
        self.events = db["ingestEvents"]
        self.state = db["systemState"]
        self._lock = threading.Lock()
        try:
            self.events.create_index("at", name="event_expiry", expireAfterSeconds=KEEP_DAYS * 86400)
        except Exception:
            pass

    def emit(self, kind, message, level="info", **data):
        try:
            self.events.insert_one({"at": datetime.now(timezone.utc), "kind": kind, "level": level,
                                    "message": str(message)[:400], "data": data})
        except Exception:
            pass  # monitoring must never break publishing

    def set_state(self, **fields):
        fields["heartbeat"] = now_iso()
        fields["pid"] = os.getpid()
        try:
            with self._lock:
                self.state.update_one({"_id": "generator"}, {"$set": fields}, upsert=True)
        except Exception:
            pass

    def get_state(self):
        return self.state.find_one({"_id": "generator"}) or {}

    def recent(self, after=None, limit=100, kind_prefix=None):
        q = {}
        if kind_prefix:
            q["kind"] = {"$regex": "^" + kind_prefix}
        if after:
            try:
                from bson import ObjectId
                q["_id"] = {"$gt": ObjectId(after)}
            except Exception:
                pass
        cur = self.events.find(q).sort("_id", -1).limit(min(limit, 500))
        out = []
        for e in cur:
            out.append({"id": str(e["_id"]), "at": e["at"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") +
                        f"{e['at'].microsecond // 1000:03d}Z" if e["at"].tzinfo else e["at"].isoformat() + "Z",
                        "kind": e["kind"], "level": e.get("level", "info"),
                        "message": e["message"], "data": e.get("data", {})})
        return out


class NullMonitor:
    def emit(self, *a, **k): pass
    def set_state(self, **k): pass
    def get_state(self): return {}
    def recent(self, *a, **k): return []
