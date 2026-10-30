"""
Image verification. An article is never published unless its hero image
passes ALL of these tests, by actually downloading it:

  * absolute https:// URL (http:// is upgraded to https:// if that works)
  * HTTP 200 and an image/* content type (SVG rejected: that is how logos ship)
  * real image bytes (PNG/JPEG/GIF/WEBP/AVIF signature) that Pillow can decode
  * at least 400x220 px, a photo-like aspect ratio (0.6 .. 3.2) and >= 12 KB
  * not a logo / icon / avatar / tracking pixel / placeholder by URL
"""

import io
import re
import time
from urllib.parse import urlsplit, urlunsplit

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/*;q=0.8,*/*;q=0.5",
}
MIN_W, MIN_H, MIN_BYTES, MAX_BYTES = 400, 220, 12_000, 6_000_000
MIN_ASPECT, MAX_ASPECT = 0.6, 3.2

BAD_URL_PARTS = ("logo", "icon", "favicon", "avatar", "sprite", "spacer", "pixel.", "tracking",
                 "-ad-", "/ads/", "advert", "badge", "button", "share-", "social-", "author-",
                 "profile-", "placeholder", "default-image", "1x1", "blank.gif", "/emoji/")

_SIGNATURES = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")


class NoVerifiedImage(Exception):
    """No candidate image passed verification. transient=True: every failure was a network hiccup (timeout, 5xx,
    rate limit), not a bad image, so the story is worth another try later instead of being skipped for good."""
    def __init__(self, msg="", transient=False):
        super().__init__(msg)
        self.transient = transient


TRANSIENT_MARKERS = ("request failed", "unreachable", "HTTP 5", "HTTP 429", "HTTP 408", "HTTP 403", "HTTP 401", "only 0 bytes")


def is_transient(reason):
    """A failure that may well succeed on a second look (network trouble, hotlink check), not a bad image."""
    return any(m in (reason or "") for m in TRANSIENT_MARKERS)


def looks_like_url(url):
    return isinstance(url, str) and bool(re.match(r"^https?://[^\s/]+\.[^\s/]+/\S*$", url))


def _is_image_bytes(b):
    if b.startswith(_SIGNATURES):
        return True
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return True
    return b[4:12] in (b"ftypavif", b"ftypavis")


def _verify_once(url, get=requests.get, referer=None):
    """One look at one image. Returns (ok: bool, reason: str, final_url: str|None)."""
    hdr = {**HEADERS, "Referer": referer} if referer else HEADERS
    if not looks_like_url(url):
        return False, "not an absolute image URL", None
    low = url.lower()
    if any(p in low for p in BAD_URL_PARTS):
        return False, "looks like a logo/icon/placeholder", None
    candidates = [url]
    if url.startswith("http://"):
        candidates.insert(0, "https://" + url[len("http://"):])
    last = "unreachable"
    for u in candidates:
        try:
            r = get(u, headers=hdr, timeout=12, stream=True, allow_redirects=True)
        except Exception as e:  # noqa: BLE001
            last = f"request failed ({type(e).__name__})"
            continue
        try:
            if r.status_code == 406:        # server dislikes our Accept header (CDN format negotiation): ask for anything
                try:
                    r.close()
                except Exception:
                    pass
                r = get(u, headers={**hdr, "Accept": "*/*"}, timeout=12, stream=True, allow_redirects=True)
            if r.status_code != 200:
                last = f"HTTP {r.status_code}"
                continue
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype in ("binary/octet-stream", "application/octet-stream"):
                ctype = "image/unknown"     # CDNs often mislabel photos; the bytes are checked below (signature + decode)
            if not ctype.startswith("image/") or "svg" in ctype:
                last = f"content type {ctype or 'missing'} is not a photo"
                continue
            data = b""
            for chunk in r.iter_content(65536):
                data += chunk
                if len(data) > MAX_BYTES:
                    break
            if len(data) > MAX_BYTES:
                last = "file too large"
                continue
        finally:
            try:
                r.close()
            except Exception:
                pass
        if len(data) < MIN_BYTES:
            last = f"only {len(data)} bytes"
            continue
        if not _is_image_bytes(data):
            last = "bytes are not a real image"
            continue
        try:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as im:
                im.load()
                w, h = im.size
        except Exception:
            # AVIF without Pillow support: signature + size already checked, accept.
            if data[4:12] in (b"ftypavif", b"ftypavis"):
                return True, "ok (avif)", u
            last = "image cannot be decoded"
            continue
        if w < MIN_W or h < MIN_H:
            last = f"too small ({w}x{h})"
            continue
        if not MIN_ASPECT <= w / h <= MAX_ASPECT:
            last = f"odd shape ({w}x{h}), probably a banner/logo"
            continue
        return True, f"ok ({w}x{h})", u
    return False, last, None


def verify_image(url, get=requests.get, referer=None, tries=3, sleep=time.sleep):
    """Returns (ok, reason, final_url). A network hiccup (timeout, 5xx, 429, a hotlink 403) is looked at up to
    `tries` times, with a short pause and, from the second look, the article page as Referer. A genuinely bad
    image (too small, a logo, not an image) is rejected at once."""
    res = (False, "unreachable", None)
    for i in range(max(1, tries)):
        res = _verify_once(url, get=get, referer=referer if i else None)
        if res[0] or not is_transient(res[1]):
            return res
        if i < tries - 1:
            sleep(i + 1)
    return res


def pick_verified_images(candidates, limit=3, get=requests.get, max_tries=None, referer=None):
    """(verified urls, [(candidate, why) rejected]). Looks at up to `max_tries` different candidates
    (IMAGE_TRIES, 5-10) until `limit` pass."""
    if max_tries is None:
        import config
        max_tries = config.retry_settings()["image_tries"]
    good, rejected = [], []
    for c in candidates:
        if len(good) >= limit or len(good) + len(rejected) >= max_tries:
            break
        ok, why, final = verify_image(c, get=get, referer=referer)
        (good if ok else rejected).append(final if ok else (c, why))
    return good, rejected
