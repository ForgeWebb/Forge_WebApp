-- Counters for the website's AI rate limit (api/ratelimit.py).
--
-- The website's AI now runs on one key the operator pays for (see api/ai.py),
-- so anything that can call it in a loop can run up that bill. The limiter
-- counts calls per account, per IP address and in total, in fixed windows,
-- and refuses once a count reaches its cap.
--
-- Why a table and not memory: Railway runs the API as two gunicorn workers
-- (api/Procfile), each its own process. A counter held in memory would be
-- two counters, so every limit would really be twice what it says, and every
-- redeploy would wipe them. Postgres is the one thing both workers share and
-- the one thing a redeploy does not reset.
--
-- Why its own schema: nothing a signed-in user can reach may be able to read
-- or write these rows, or a script could simply reset its own count. Supabase
-- exposes only `public` over its REST API, so `private` is not reachable
-- from a browser at all. On top of that, RLS is on with no policies and the
-- app's own `authenticated` role is granted nothing. Only the API's pool role
-- (which owns the table) touches it, via db.service_tx().
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.ai_usage (
    bucket       text        not null,  -- 'user:<uuid>', 'ip:<addr>' or 'global'
    window_start timestamptz not null,  -- start of the fixed window the count covers
    count        integer     not null default 0,
    primary key (bucket, window_start)
);

alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from public, anon, authenticated;

-- For the limiter's occasional sweep of expired windows.
create index if not exists ai_usage_window_start_idx
    on private.ai_usage (window_start);
