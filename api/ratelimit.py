"""Rate limits on the website's AI routes, so one key's bill has a ceiling.

The website's AI runs on the operator's own Gemini key (ai.py), so a script
signed in to one account, or cycling through several, could otherwise spend
it without limit. Every website AI call is counted against three kinds of
bucket, and refused with a 429 once any of them is full:

  * per account, per hour and per day. The normal case: one person who is
    really using the site, bounded.
  * per IP address, per day. Catches one machine running many accounts,
    since making an account costs nothing. Set generously, because a whole
    school can sit behind one address.
  * global, per day. The actual bill guarantee. Whatever gets past the other
    two, the total is capped.

The desktop is not counted at all. It calls with each account's own key
(see ai.for_user), so its usage is that account's bill, not the operator's.

**Counting lives in Postgres**, in private.ai_usage (migration 0012), not in
memory. The API runs as two gunicorn workers, so an in-memory count would be
two counts and every limit would silently be double; and every redeploy would
reset it. See the migration for why the table sits where no user can reach it.

**A refused call counts for nothing.** Every bucket is incremented, then the
new counts are checked, and if any is over its cap the transaction is rolled
back -- so the increments never happened. Doing it the other way round (check
all, then increment) would leave someone already over their own limit able to
keep hammering, spend nothing, and still run the *global* count to its cap,
shutting AI off for everybody else. Doing it in one transaction is what makes
two requests racing for the last slot unable to both get it.

Windows are fixed, not sliding: "per day" means per UTC day. A sliding
window is fairer at the edges but needs a row per call. For a cost ceiling
the edge effect (at most twice a limit across a boundary) doesn't matter.

Every cap is an environment variable on Railway (config.py lists them), so
they can be tuned without a deploy. A cap of 0 or less switches that limit
off.
"""

import logging
import random
from datetime import datetime, timezone
from functools import wraps

from flask import g, jsonify, request

import ai
import config
import db

log = logging.getLogger(__name__)

HOUR = 3600
DAY = 86400

# (who, window, cap, what to tell someone who hit it). `who` is the prefix of
# the bucket key; the window is part of the key too (see _buckets), so the
# hourly and daily counts for one account are separate rows even in the hour
# where both windows start at the same instant.
LIMITS = [
    ("user", HOUR, config.AI_LIMIT_USER_PER_HOUR,
     "You've made a lot of AI requests this hour. Try again in {wait}."),
    ("user", DAY, config.AI_LIMIT_USER_PER_DAY,
     "You've reached today's limit for AI requests. It resets in {wait}."),
    ("ip", DAY, config.AI_LIMIT_IP_PER_DAY,
     "Too many AI requests from this network today. Try again in {wait}."),
    ("global", DAY, config.AI_LIMIT_GLOBAL_PER_DAY,
     "The website's AI has hit its daily limit. It resets in {wait}."),
]


class Limited(Exception):
    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = retry_after


def client_ip():
    """The caller's address as Railway's edge saw it.

    Behind Railway's proxy, `remote_addr` is the proxy itself. The client is
    in X-Forwarded-For, and the entry to trust is the **last** one, the one
    Railway's edge appended. Anything before it was supplied by the client
    and could be made up, so reading the first entry would let a script pick
    a fresh "IP" for every request.
    """
    forwarded = [p.strip() for p in
                 request.headers.get("X-Forwarded-For", "").split(",") if p.strip()]
    return forwarded[-1] if forwarded else (request.remote_addr or "unknown")


def _window_start(now, seconds):
    epoch = int(now.timestamp())
    return datetime.fromtimestamp(epoch - epoch % seconds, tz=timezone.utc)


def _wait_text(seconds):
    if seconds < 3600:
        minutes = max(1, round(seconds / 60))
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = max(1, round(seconds / 3600))
    return f"{hours} hour{'s' if hours != 1 else ''}"


def _buckets(user_id, ip, now):
    """[(key, window_start, cap, message, seconds_left)] for every live limit."""
    out = []
    for who, window, cap, message in LIMITS:
        if cap <= 0:
            continue
        ident = {"user": user_id, "ip": ip, "global": "all"}[who]
        if ident is None:
            continue          # background work has no user or IP to charge
        start = _window_start(now, window)
        left = int(window - (now - start).total_seconds())
        out.append((f"{who}:{ident}:{window}", start, cap, message, left))
    return out


# One statement: bump every bucket and report what each became.
#
# `order by` matters and is not cosmetic. Two concurrent requests generally
# share some buckets (the global one always, the IP one often) and not others,
# so if one locked `global` before `ip` while the other did the reverse, they
# could deadlock. Rows are processed in the order this select yields them, so
# sorting by the key makes every caller take its locks in the same order.
_BUMP = """
insert into private.ai_usage (bucket, window_start, count)
select b, w, 1
  from unnest(%s::text[], %s::timestamptz[]) as t(b, w)
 order by b, w
    on conflict (bucket, window_start)
    do update set count = private.ai_usage.count + 1
 returning bucket, window_start, count
"""


def take(user_id, ip, now=None):
    """Count one AI call against every bucket, or raise Limited.

    The increments are rolled back if any bucket came out over its cap -- the
    exception propagates out of `service_tx`, whose transaction unwinds it.
    See the module docstring for why a refused call has to cost nothing.
    """
    now = now or datetime.now(timezone.utc)
    buckets = _buckets(user_id, ip, now)
    if not buckets:
        return
    keys = [b[0] for b in buckets]
    starts = [b[1] for b in buckets]

    with db.service_tx() as conn:
        rows = conn.execute(_BUMP, (keys, starts)).fetchall()
        counts = {(r["bucket"], r["window_start"]): r["count"] for r in rows}

        for key, start, cap, message, left in buckets:
            # `>` not `>=`: this count already includes the call being made,
            # so a cap of 20 must allow the 20th through and refuse the 21st.
            if counts.get((key, start), 0) > cap:
                # The kind of bucket, never the account id or the address.
                log.info("AI rate limit hit: %s", key.split(":", 1)[0])
                raise Limited(message.format(wait=_wait_text(left)), left)

        # Old windows are dead weight. Rather than a cron job, roughly one call
        # in two hundred clears anything more than two days old.
        if random.random() < 0.005:
            conn.execute("delete from private.ai_usage "
                         "where window_start < now() - interval '2 days'")


def take_global():
    """Count background AI work (topic naming) against the daily total only.

    Runs off the request thread, so there is no account or IP to charge it
    to. It still spends the operator's key, though, so it still counts.
    """
    take(None, None)


def limit_website_ai(view):
    """Decorator for AI routes: refuse with 429 once a limit is reached.

    Goes *under* @require_user, so g.user_id is set. It runs before the view
    opens any transaction of its own, so a refused call costs one small
    query and never holds two connections at once.
    """
    @wraps(view)
    def wrapped(*args, **kwargs):
        if ai.is_website_request():
            try:
                take(g.user_id, client_ip())
            except Limited as e:
                return (jsonify({"error": str(e), "code": "rate_limited"}), 429,
                        {"Retry-After": str(max(1, e.retry_after))})
        return view(*args, **kwargs)
    return wrapped
