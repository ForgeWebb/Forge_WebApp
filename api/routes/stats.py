"""Lifetime numbers, the practice streak, and the five analysis panels.

Everything here aggregates in Postgres rather than pulling rows out and summing
them in Python. That is not premature: `select * from user_stats` is unbounded
in the number of games played, and the answer is nine numbers however many rows
back it.

The panels are the same principle taken seriously. On the desktop each one is a
matplotlib PNG rendered on the server and returned as base64 inside a JSON
body; here the routes return numbers and a written finding, and the browser
draws. The reasoning ports unchanged and lives in `panels.py`; only the picture
was thrown away.

Three of the five change query shape on the way over, and all three for the
same reason -- work that belongs in the database was being done in Python:

  * **Where You Buzz** ran one query per band, four round trips for four
    numbers. One grouped query now.
  * **The neg autopsy** selected every qualifying row of `user_stats` and
    bucketed them in a loop. It is a cross-tab; Postgres does cross-tabs. At
    most eleven difficulties by four bands comes back instead of the whole
    answer history.
  * **Ceiling's tier labels** grouped all 169,056 questions on every request.
    Cached per process now -- see `_tier_labels`.

Scoping matches either level of the category, `(category = %s or subcategory =
%s)`. On the desktop build the profile filtered on `category` alone while
adaptive sessions logged the subcategory, so 17 of 20 filters silently matched
zero rows and every panel came up empty -- and the three that worked were the
categories that happen to mirror their own name, which made the feature look
like it worked.
"""

import threading
import traceback

from flask import Blueprint, g, jsonify, request

import adaptive
import ratelimit
import ai
import clusters
import db
import panels
from auth import require_user
from clock import local_day

bp = Blueprint("stats", __name__, url_prefix="/api/stats")

# Days with at least one answer count toward the streak. It would be easy to
# reuse the 5-answer gate the accuracy trend uses, but that gate answers a
# different question -- "is this day's accuracy readable" -- and one answer is
# a thin measurement while being a solid fact: you showed up. A streak that
# breaks on a day you did practise is the one thing a streak must never do.


def _scope():
    category = (request.args.get("category") or "").strip()
    if not category or category.lower() == "all":
        return "", []
    return "and (category = %s or subcategory = %s)", [category, category]


def _answer_scope():
    """`_scope` plus an optional single session, for user_stats only.

    `progress_daily` and `review_queue` have no session column -- a day and a
    queue entry outlive the sitting that produced them -- so the panels built
    on those tables take the category filter and nothing else.
    """
    clause, params = _scope()
    session_id = (request.args.get("session") or "").strip()
    if session_id:
        clause += " and session_id = %s"
        params.append(session_id)
    return clause, params


@bp.get("/summary")
@require_user
def summary():
    """Lifetime numbers, the review queue's shape, and the practice streak.

    `?session=` narrows the first of those to one Adaptive Learning sitting,
    which is what the records page opens the profile with. The other two are
    left out entirely in that case rather than answered from the whole
    account: a streak is a property of a calendar and a review queue is a
    property of an account, and neither becomes a fact about one sitting just
    because it was asked for alongside one. Returning the lifetime figures
    under a session filter would put a nine-day streak on the page next to
    six answers and invite exactly the wrong reading.
    """
    clause, params = _answer_scope()
    session_id = (request.args.get("session") or "").strip()

    with db.user_tx(g.user_id) as conn:
        totals = conn.execute(
            f"""select count(*)                                              as tossups,
                       count(*) filter (where outcome = 'power')             as powers,
                       count(*) filter (where outcome = 'ten')               as tens,
                       count(*) filter (where outcome = 'neg')               as negs,
                       count(*) filter (where outcome = 'pass')              as passes,
                       coalesce(sum(case outcome when 'power' then 15
                                                 when 'ten'   then 10
                                                 when 'neg'   then -5
                                                 else 0 end), 0)             as points,
                       -- Correct buzzes only. This used to include negs,
                       -- which made "Avg celerity" mean one thing in the
                       -- reader's own session box (correct-only, on both
                       -- clients) and another on the profile and the records
                       -- page, under the same label. Two comments already
                       -- asserted this filter as fact -- panels.buzzpoints's
                       -- docstring and main.js's recordSessionAnswer, which
                       -- says it leaves negs out "for the same reason the
                       -- server's own lifetime average" does -- so the SQL
                       -- was the outlier, not the intent. A neg's celerity
                       -- says how early you were wrong, not how well you
                       -- played, and averaging the two together pulls the
                       -- figure toward whoever negs earliest.
                       avg(celerity) filter (
                           where outcome in ('power', 'ten'))                as avg_celerity
                  from public.user_stats
                 where user_id = %s {clause}""",
            [g.user_id] + params).fetchone()

        if session_id:
            return jsonify({
                "lifetime": _lifetime(totals),
                "session": session_id,
                "review": None,
                "streak": None,
                "daysPlayed": None,
            })

        review = conn.execute(
            """select count(*)                                                as total,
                      count(*) filter (where learned_at is not null)          as learned,
                      count(*) filter (where learned_at is null
                                         and (sm2_due is null
                                              or sm2_due <= now()))           as due_now
                 from public.review_queue
                where user_id = %s""",
            (g.user_id,)).fetchone()

        # The whole play calendar, one row per day, most recent first. The
        # streak is walked in Python because it is a run-length over at most a
        # few hundred rows and expressing it as a window function makes it
        # unreadable for no measurable gain.
        # Category only, never the session -- progress_daily has no session
        # column, because a day outlives the sitting that filled it.
        day_clause, day_params = _scope()
        days = [r["day"] for r in conn.execute(
            f"""select day
                  from public.progress_daily
                 where user_id = %s and answers > 0 {day_clause}
              group by day
              order by day desc""",
            [g.user_id] + day_params).fetchall()]

    return jsonify({
        "lifetime": _lifetime(totals),
        "session": None,
        "review": dict(review),
        # The player's own calendar, not the server's -- see clock.py.
        "streak": _streak(days, local_day(request.args.get("timezone"))),
        "daysPlayed": len(days),
    })


def _lifetime(totals):
    return {
        "tossups": totals["tossups"],
        "powers": totals["powers"],
        "tens": totals["tens"],
        "negs": totals["negs"],
        "passes": totals["passes"],
        "points": totals["points"],
        "averageCelerity": totals["avg_celerity"],
    }


def _streak(days, today):
    """Consecutive days played, ending today or yesterday.

    Yesterday still counts as alive. A streak that reset at midnight would read
    0 every morning until the first answer of the day, telling someone who has
    not had breakfast that they broke it -- so the run stands while its last
    day is today or yesterday, and the "at risk" case is flagged rather than
    zeroed, because it is the only state with something to do about it.
    """
    if not days:
        return {"current": 0, "atRisk": False, "best": 0, "lastPlayed": None}

    gap = (today - days[0]).days
    if gap > 1:
        current = 0
    else:
        current = 1
        for earlier, later in zip(days[1:], days):
            if (later - earlier).days != 1:
                break
            current += 1

    best = run = 1
    for earlier, later in zip(days[1:], days):
        run = run + 1 if (later - earlier).days == 1 else 1
        best = max(best, run)

    return {
        "current": current,
        "atRisk": current > 0 and gap == 1,
        "best": best,
        "lastPlayed": days[0].isoformat(),
    }


# --------------------------------------------------------------- the panels ---

# difficulty -> the tournament series that actually sit at it, computed once
# per process. This is the one cache in the API, and it is safe for the reason
# nothing else is: it is derived from the shared, read-only question set, so it
# is identical for every user and only changes when the question database is
# replaced. Caching anything per-user in module state is what makes the desktop
# adaptive session unable to survive a second worker (see adaptive.py).
_tier_labels = None


def tier_labels(conn):
    """Every set carries exactly one difficulty, so difficulty *is* the tier.

    That means a separate "tournament readiness" panel would be this same data
    with different labels, so the names hang off the difficulty levels instead
    -- which is where the value was. "Difficulty 8" is abstract; "ACF Regionals
    level" is a tournament you can enter.

    Top three series per difficulty, ranked in SQL. The desktop pulls every
    (difficulty, set_name) pair back and counts them in Python.
    """
    global _tier_labels
    if _tier_labels is not None:
        return _tier_labels

    rows = conn.execute(
        r"""select difficulty, series
              from (select difficulty,
                           -- Strip the leading year so it reads as a tier
                           -- ("ACF Regionals") rather than as one specific
                           -- event ("2024 ACF Regionals").
                           regexp_replace(set_name, '^\s*(19|20)\d{2}\s+', '') as series,
                           row_number() over (partition by difficulty
                                                  order by count(*) desc) as rank
                      from public.questions
                     where set_name is not null and difficulty is not null
                  group by difficulty, series) ranked
             where rank <= 3
          order by difficulty, rank""").fetchall()

    labels = {}
    for row in rows:
        labels.setdefault(row["difficulty"], []).append(row["series"])
    _tier_labels = labels
    return _tier_labels


@bp.get("/buzzpoints")
@require_user
def buzzpoints():
    """Where You Buzz: points earned per buzz, by quarter of the tossup."""
    clause, params = _answer_scope()

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select {panels.BAND_CASE} as band,
                       count(*)                                    as buzzes,
                       count(*) filter (where outcome = 'power')   as powers,
                       count(*) filter (where outcome = 'ten')     as tens,
                       count(*) filter (where outcome = 'neg')     as negs
                  from public.user_stats
                 where user_id = %s
                   and outcome in ('power', 'ten', 'neg')
                   and {panels.BAND_BOUNDS} {clause}
              group by band""",
            [g.user_id] + params).fetchall()

    return jsonify(panels.buzzpoints(rows))


@bp.get("/ceiling")
@require_user
def ceiling():
    """Ceiling: accuracy at each difficulty, and where the wall is."""
    clause, params = _answer_scope()

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select difficulty,
                       count(*)                                           as attempts,
                       count(*) filter (where outcome in ('power','ten')) as correct,
                       sum(case outcome when 'power' then 15
                                        when 'ten'   then 10
                                        when 'neg'   then -5 end)         as points
                  from public.user_stats
                 where user_id = %s
                   and difficulty is not null
                   and outcome in ('power', 'ten', 'neg') {clause}
              group by difficulty
              order by difficulty""",
            [g.user_id] + params).fetchall()

        # Only pay for the labels when there is something to label.
        tiers = tier_labels(conn) if rows else {}

    return jsonify(panels.ceiling(rows, tiers))


@bp.get("/negs")
@require_user
def negs():
    """Neg Autopsy: neg rate as a difficulty by buzz-point cross-tab."""
    clause, params = _answer_scope()

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select difficulty,
                       {panels.BAND_CASE} as band,
                       count(*)                                as buzzes,
                       count(*) filter (where outcome = 'neg') as negs
                  from public.user_stats
                 where user_id = %s
                   and outcome in ('power', 'ten', 'neg')
                   and difficulty is not null
                   and {panels.BAND_BOUNDS} {clause}
              group by difficulty, band
              order by difficulty, band""",
            [g.user_id] + params).fetchall()

    return jsonify(panels.neg_autopsy(rows))


@bp.get("/retention")
@require_user
def retention():
    """Retention: SM-2 easiness per subject -- does what you learn stay learned?

    Scoped on the *question's* category rather than on a column of the queue
    table, so this filter reads `q.category` where the others read `category`.
    Worth spelling out rather than reaching for the shared helper and quietly
    filtering on the wrong table.
    """
    category = (request.args.get("category") or "").strip()
    clause, params = "", []
    if category and category.lower() != "all":
        clause = "and (q.category = %s or q.subcategory = %s)"
        params = [category, category]

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select q.category,
                       count(*)             as reviewed,
                       avg(r.sm2_ef)        as ef,
                       sum(r.attempts)      as attempts,
                       sum(r.total_correct) as correct,
                       avg(r.sm2_interval)  as interval_days
                  from public.review_queue r
                  join public.questions q on q.id = r.question_id
                 where r.user_id = %s and r.attempts > 0 {clause}
              group by q.category
              order by avg(r.sm2_ef) asc""",
            [g.user_id] + params).fetchall()

    return jsonify(panels.retention(rows))


@bp.get("/progress")
@require_user
def progress():
    """Progress Over Time: one calendar month of accuracy and buzz point.

    Reads `progress_daily`, which "Reset Stats" deliberately leaves alone -- a
    record of how someone has changed over months is the one thing a reset has
    no business erasing.
    """
    clause, params = _scope()
    month = (request.args.get("month") or "").strip() or None
    # A malformed month is not worth failing on: the panel falls back to the
    # most recent month with play in it, which is what the caller wanted.
    if month and (len(month) != 7 or month[4] != "-"
                  or not month[:4].isdigit() or not month[5:].isdigit()):
        month = None

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select day,
                       sum(answers)      as answers,
                       sum(correct)      as correct,
                       sum(negs)         as negs,
                       sum(points)       as points,
                       sum(celerity_sum) as celerity_sum,
                       sum(celerity_n)   as celerity_n
                  from public.progress_daily
                 where user_id = %s {clause}
              group by day
              order by day""",
            [g.user_id] + params).fetchall()

    return jsonify(panels.progress(rows, month))


def _name_clusters_in_background(user_id, pairs):
    """Ask Gemini to name these clusters off the request path, and cache
    whatever it comes back with for next time.

    `knowledge_depth()` used to make the Gemini call inline -- the one place
    in this whole API a third-party network call sat in the response path.
    Every database fix elsewhere in this file is worth milliseconds; a
    Gemini call is worth seconds, sometimes several, and it ran on every
    single open of this panel for as long as any of the player's clusters
    stayed unnamed. Deferred here instead: the panel already has its instant,
    cheaply-picked fallback label (`clusters.quick_examples`) by the time
    this even starts, and a real name lands in `cluster_labels` for every
    later visit -- by anyone, it's a shared, permanent table, not scoped to
    this account -- once this finishes.

    The *scored* examples Gemini actually wants (`clusters.representative_examples`,
    the CPU-bound word-frequency pass) are fetched here too, not by the
    caller -- that scoring only matters for what gets named the highest-
    quality name, which is exactly the thing already deferred to this thread.
    It shares its DB fetch with the caller's cheap pick via
    `clusters._raw_examples_cache`, so this doesn't cost a second query.

    Fire-and-forget on a daemon thread. `cache_names`'s own
    `on conflict do nothing` makes a retry (this account's next visit, or
    someone else's landing first) safe to just try again, so nothing here
    needs to be certain of finishing.
    """
    # Decided here, on the request thread, because the thread below has no
    # request to read the header off -- see ai.is_website_request.
    website = ai.is_website_request()

    def name():
        try:
            if website:
                # Charged to the daily total only -- there is no request here
                # to read an account or an address off. Raises Limited, which
                # the AIError/Exception handlers below do not catch, so the
                # `except Exception` is what swallows it: nothing to report,
                # the fallback labels already on screen stand.
                ratelimit.take_global()
            with db.user_tx(user_id) as conn:
                getter = ai.for_user(conn, user_id, website=website)
                examples = clusters.representative_examples(conn, pairs)
            groups = [{"id": f"{sub}#{cid}", "answers": examples[(sub, cid)]}
                      for sub, cid in pairs if examples.get((sub, cid))]
            if not groups:
                return
            ai_named = getter.name_topic_clusters(groups) or {}
            fresh = {}
            for sub, cid in pairs:
                label = str(ai_named.get(f"{sub}#{cid}") or "").strip()
                if label:
                    fresh[(sub, cid)] = label
            if fresh:
                with db.user_tx(user_id) as conn:
                    clusters.cache_names(conn, fresh)
        except ai.NoKeyConfigured:
            pass    # nothing to name without a key -- not an error
        except ai.AIError:
            pass    # offline, quota, a bad reply -- the fallback already shown stands
        except Exception:
            traceback.print_exc()

    threading.Thread(target=name, name="name-clusters", daemon=True).start()


@bp.get("/knowledge-depth")
@require_user
def knowledge_depth():
    """Knowledge Depth: the recommender's own per-cluster skill, named.

    Every player gets a working panel immediately -- a name attached to a
    cluster is not required for the skill numbers underneath it to be real,
    so an unnamed cluster's label is a few example answerlines joined
    together (see `clusters.FALLBACK_EXAMPLES`) rather than a wait.
    `panels.knowledge_depth`'s `namedByAi` tells the frontend which kind of
    name a cluster actually got, so it can show that distinction if it wants
    to; naming with AI happens after this response, not before it -- see
    `_name_clusters_in_background`.
    """
    category = (request.args.get("category") or "").strip()
    scoped = category if category and category.lower() != "all" else None
    user_id = g.user_id

    with db.user_tx(user_id) as conn:
        subjects = adaptive.cluster_skills(conn, user_id, scoped)
        pairs = [(s["subcategory"], c["cluster"])
                 for s in subjects for c in s["clusters"]]

        names = clusters.cached_labels(conn, pairs)
        missing = [p for p in pairs if p not in names]
        # Cheap and unscored -- see clusters.quick_examples's own comment.
        # The scored version Gemini actually wants is fetched by the
        # background pass below, not here; this request never pays for that
        # ranking, only for a few distinct examples to join into a label.
        examples = clusters.quick_examples(conn, missing)

    for sub, cid in missing:
        picked = examples.get((sub, cid)) or []
        names[(sub, cid)] = (
            ", ".join(picked[:clusters.FALLBACK_EXAMPLES]) if picked
            else f"Topic {cid}")

    if missing:
        _name_clusters_in_background(user_id, missing)

    # Never true for a cluster named just now -- that naming hasn't happened
    # yet by the time this response goes out. True only when every cluster
    # this player has was already named by a *previous* visit's background
    # pass (this one's or someone else's).
    named_by_ai = len(missing) == 0
    shaped = [{
        "subcategory": s["subcategory"],
        "category": s["category"],
        "clusters": [{"cluster": c["cluster"], "skill": c["skill"],
                      "label": names.get((s["subcategory"], c["cluster"]))
                               or f"Topic {c['cluster']}"}
                     for c in s["clusters"]],
    } for s in subjects]

    return jsonify(panels.knowledge_depth(
        shaped, only_category=category or None, named_by_ai=named_by_ai))


@bp.post("/reset")
@require_user
def reset():
    """Reset All Stats: clear the lifetime record, keep everything else.

    Only `user_stats` is deleted -- matching `reset_all_stats()` in the
    desktop's `stats_manager.py` exactly, right down to what it refuses to
    touch:

    * **`progress_daily` survives.** Every panel on the profile except
      Progress Over Time is a snapshot rebuilt from `user_stats`, so wiping
      that table legitimately blanks them. Progress Over Time is a record of
      how the player changed over months, and "reset my numbers" has never
      meant "erase my history" -- it is the one thing on the page a reset has
      no business erasing.
    * **The review queue, the notebook, and Adaptive Learning's skill model
      all survive too.** A neg you are still relearning does not stop being
      unlearned because the number that counted it got reset, a saved note is
      not a stat, and `category_user_state` is a model of what you know, not
      a scoreboard -- resetting the scoreboard should not un-teach the
      recommender everything it has learned about you. The desktop reset
      leaves all three alone as well; nothing here is a new decision.

    One statement, inside the user's own RLS-scoped transaction, so this can
    only ever delete the caller's own rows -- there is no `where` clause to
    forget here, because there is nothing else in the statement to forget it
    on.
    """
    with db.user_tx(g.user_id) as conn:
        deleted = conn.execute(
            "delete from public.user_stats where user_id = %s returning 1",
            (g.user_id,)).fetchall()

    return jsonify({
        "reset": True,
        "rowsDeleted": len(deleted),
        "message": "Your statistics have been reset. Your progress history, "
                   "review queue and notes are kept.",
    })


# ----------------------------------------------------------------------------
# Four more panels, desktop-only. The five above match what the web client's
# own Profile page shows; the desktop build has always shown four more that
# the web port never got (`forge_backend/stats_manager.py`'s
# `get_points_per_category_chart`, `get_aggressive_play_analysis`,
# `get_buzz_spread_chart`, `get_submission_time_chart`). Added here, following
# the same conventions as the five above -- Postgres aggregation, one round
# trip, `_answer_scope()` -- so the desktop backend
# (`forge_backend/cloud.py`) can proxy to these instead of querying local
# SQLite, the same migration every other desktop route has already gone
# through. See NEXT_SESSION_PROMPT_DESKTOP_CLOUD.md's stats/profile section.
# ----------------------------------------------------------------------------

@bp.get("/played-categories")
@require_user
def played_categories():
    """What the profile's own category filter should offer -- every category
    and subcategory this account has actually answered a question in, with a
    count, at both levels.

    Desktop-only (see the module note above `/points-by-category`). Ported
    from `forge_backend/merged_api.py`'s `/profile/categories`, which reads
    this off local SQLite `user_stats` -- the same table every other route in
    this section reads from Postgres instead now.
    """
    with db.user_tx(g.user_id) as conn:
        cat_rows = conn.execute(
            """select category, count(*) as n from public.user_stats
                where user_id = %s and category is not null and category != ''
             group by category order by n desc""",
            (g.user_id,)).fetchall()
        sub_rows = conn.execute(
            """select subcategory, category, count(*) as n from public.user_stats
                where user_id = %s and subcategory is not null and subcategory != ''
             group by subcategory, category order by n desc""",
            (g.user_id,)).fetchall()

    categories = [{"name": r["category"], "answers": r["n"], "level": "category"}
                 for r in cat_rows]
    seen = {c["name"] for c in categories}
    subcategories = []
    for r in sub_rows:
        # A subcategory that repeats its own category is not a second filter,
        # it is the same one (Mythology, Geography, Philosophy).
        if r["subcategory"] in seen or r["subcategory"] == r["category"]:
            continue
        subcategories.append({"name": r["subcategory"], "answers": r["n"],
                              "level": "subcategory", "parent": r["category"]})

    return jsonify({"categories": categories, "subcategories": subcategories})


@bp.get("/points-by-category")
@require_user
def points_by_category():
    """Points summed per category, compared across every category at once.

    The one panel here that is inherently cross-category: everything else in
    this file scopes to a single category or the whole account, but "which
    subject is actually worth my time" only means something measured against
    every other subject at once -- so unlike every other route here, this one
    takes no `category` filter at all. Negs count -5, exactly as they do in
    the lifetime total, so a category with only negs in it still shows up
    rather than vanishing for having nothing positive to sum.
    """
    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            """select category,
                      sum(case outcome when 'power' then 15
                                       when 'ten'   then 10
                                       when 'neg'   then -5
                                       else 0 end) as points
                 from public.user_stats
                where user_id = %s and category is not null
             group by category
             order by points desc""",
            (g.user_id,)).fetchall()

    return jsonify({"categories": [
        {"category": r["category"], "points": r["points"] or 0} for r in rows]})


@bp.get("/aggressive-play")
@require_user
def aggressive_play():
    """Think Then Buzz: accuracy split by whether the buzz came before or
    after `thresholdMs` of thinking time.

    One grouped query rather than the desktop's two -- `submission_time_ms >
    threshold` is computed once in the `select`, and Postgres groups the two
    halves in the same pass instead of two round trips for two numbers.
    """
    clause, params = _answer_scope()
    try:
        threshold = int(request.args.get("thresholdMs", 2500))
    except (TypeError, ValueError):
        threshold = 2500

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select (submission_time_ms > %s) as thinking, outcome, count(*) as n
                  from public.user_stats
                 where user_id = %s and submission_time_ms is not null {clause}
              group by thinking, outcome""",
            [threshold, g.user_id] + params).fetchall()

    thinking_counts = {r["outcome"]: r["n"] for r in rows if r["thinking"]}
    reflex_counts = {r["outcome"]: r["n"] for r in rows if not r["thinking"]}
    return jsonify(panels.aggressive_play(thinking_counts, reflex_counts, threshold))


@bp.get("/buzz-spread")
@require_user
def buzz_spread():
    """A 10-bin histogram of exactly where in the tossup a buzz landed.

    Distinct from `/buzzpoints` above, which prices four fixed quarters --
    this is a finer, unpriced distribution, "how often do you actually buzz
    here" rather than "what is a buzz here worth". `least(..., bins - 1)`
    matches the desktop's own clamp (`min(int(read * bins), bins - 1)`) for
    the one edge case where `celerity` reads as exactly 0 on a last-word buzz
    and would otherwise compute a bin one past the end.
    """
    clause, params = _answer_scope()
    bins = 10

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select least(floor((1 - celerity) * %s)::int, %s - 1) as bin,
                       (outcome in ('power', 'ten')) as correct,
                       count(*) as n
                  from public.user_stats
                 where user_id = %s and celerity is not null
                   and outcome in ('power', 'ten', 'neg') {clause}
              group by bin, correct""",
            [bins, bins, g.user_id] + params).fetchall()

    correct = [0] * bins
    wrong = [0] * bins
    for r in rows:
        if r["bin"] is None:
            continue
        (correct if r["correct"] else wrong)[r["bin"]] = r["n"]

    return jsonify({"bins": bins, "correct": correct, "wrong": wrong})



# Both consumers only ever draw a 10-20 bin histogram and a median off this,
# neither of which needs every row once there are thousands of them -- a
# random sample this size is visually indistinguishable in a histogram and
# accurate to well under a tenth of a second in the median, for either
# consumer's purposes. Left generous on purpose: this is a payload-size cap
# for the small fraction of accounts with tens of thousands of recorded
# buzzes, not a real sample-size restriction on anyone else -- an account
# under this stays completely unaffected.
_SUBMISSION_TIME_SAMPLE_CAP = 4000


@bp.get("/submission-time")
@require_user
def submission_time():
    """Every recorded submission time, in seconds, split by right vs. wrong
    (capped at _SUBMISSION_TIME_SAMPLE_CAP -- see its own comment).

    Sent as two raw lists rather than pre-binned: the desktop's histogram
    (`ax.hist(..., bins=20)`) picks its own bin edges from whatever range the
    data actually spans, and pre-binning here would mean guessing edges that
    then have to match what the chart draws. Also doubles as the source for
    the "thinking time" note in `get_chart_notes` (a median over the same
    values), so this is the one panel here fetched for two different reasons
    rather than one.
    """
    clause, params = _answer_scope()

    with db.user_tx(g.user_id) as conn:
        rows = conn.execute(
            f"""select submission_time_ms, (outcome in ('power', 'ten')) as correct
                  from public.user_stats
                 where user_id = %s and submission_time_ms is not null
                   and outcome in ('power', 'ten', 'neg') {clause}
              order by random()
                 limit %s""",
            [g.user_id] + params + [_SUBMISSION_TIME_SAMPLE_CAP]).fetchall()

    correct_times = [r["submission_time_ms"] / 1000.0 for r in rows if r["correct"]]
    incorrect_times = [r["submission_time_ms"] / 1000.0 for r in rows if not r["correct"]]
    return jsonify({"correctTimes": correct_times, "incorrectTimes": incorrect_times})
