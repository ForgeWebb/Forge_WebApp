"""Database access, always inside a transaction that knows whose it is.

Two things happen on every request that touches user data, and the second one
is the one worth reading twice:

  1. The connection switches to the `authenticated` role for the duration of
     the transaction. The role the pool logs in as can see every row in every
     table; `authenticated` sees only what a policy lets it. Without this line
     the policies in 0002_user_data.sql are written, enabled, and never
     consulted -- which is indistinguishable from working right up until the
     day a query forgets its WHERE clause.

  2. The verified user id is put on the transaction as `request.jwt.claims`,
     which is where Supabase's `auth.uid()` reads from. That is what the
     policies compare each row against.

Both are transaction-local (`set_config(..., true)`), so they unwind when the
transaction ends and cannot leak onto the next request that borrows the same
pooled connection.

Application code still writes `where user_id = %s` on top of this. The belt is
RLS; the braces are the WHERE clause. Either alone would be enough on a good
day, and the point is not to depend on a good day.
"""

import json
import logging
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

import config

log = logging.getLogger(__name__)

pool = ConnectionPool(
    config.DATABASE_URL,
    min_size=1,
    max_size=8,
    kwargs={"row_factory": dict_row},
    open=False,
)


def open_pool():
    """Open the pool at startup, but do not die if the database is slow to answer.

    This runs at import time, inside `create_app()`, which means a raise here
    stops `app = create_app()` from ever binding -- gunicorn then cannot load
    `app:app` and *every* request 502s, `/api/health` included, on a crash
    loop with no app code in the trace. A cold Supabase instance or a brief
    network blip at deploy time is enough to trigger that.

    `pool.open()` starts the background connection task regardless; `wait()`
    only blocks boot until the first connection is ready. If it isn't ready in
    time, the pool keeps trying on its own and the first data request either
    succeeds a moment later or surfaces a real database error -- both of which
    are recoverable, unlike a deploy that never came up.
    """
    pool.open()
    try:
        pool.wait(timeout=10)
    except PoolTimeout:
        log.warning(
            "Database not reachable within 10s of startup; continuing. The "
            "connection pool will keep retrying in the background."
        )


def close_pool():
    pool.close()


@contextmanager
def user_tx(user_id):
    """A transaction scoped to one user, with RLS actively enforcing it."""
    with pool.connection() as conn:
        with conn.transaction():
            # Claims first, role second: after the role switch this connection
            # is deliberately less privileged, so do the setup while it still
            # has the privileges to do it. Both set_config calls are combined
            # into one round trip -- claims still land before the role switch,
            # in the same statement, so there's no window where one is set and
            # not the other.
            conn.execute(
                "select set_config('request.jwt.claims', %s, true),"
                " set_config('role', 'authenticated', true)",
                (json.dumps({"sub": user_id, "role": "authenticated"}),),
            )
            yield conn


@contextmanager
def service_tx():
    """A transaction as the pool's own role, with no user attached.

    For bookkeeping that belongs to the service rather than to any one
    account. The only user is ratelimit.py's counter table, which must *not*
    be reachable by the `authenticated` role, since a user who could write it
    could reset their own limit. Deliberately no role switch, so nothing that
    reads user data should ever go through here: the WHERE-clause-plus-RLS
    rule in this module's docstring does not apply inside it.
    """
    with pool.connection() as conn:
        with conn.transaction():
            yield conn


@contextmanager
def content_tx():
    """A transaction for the shared question set.

    Still runs as `authenticated` rather than as the pool's own role. The
    question tables grant select and nothing else, so a bug in a content query
    cannot write to them however it is worded.
    """
    with pool.connection() as conn:
        with conn.transaction():
            conn.execute("select set_config('role', 'authenticated', true)")
            yield conn
