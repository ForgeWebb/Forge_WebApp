"""Settings, read once at import and checked loudly.

Everything here comes from the environment. Nothing is defaulted to a working
value, because a secret with a fallback is a secret that ships.
"""

import os

from dotenv import load_dotenv

load_dotenv()


def _required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy web/api/.env.example to web/api/.env "
            "and fill it in.")
    return value


# https://<project-ref>.supabase.co
SUPABASE_URL = _required("SUPABASE_URL").rstrip("/")

# Postgres connection string. Use the *pooler* string in anything that scales
# out -- Supabase's direct connection has a low connection cap and a serverless
# deployment will exhaust it.
DATABASE_URL = _required("DATABASE_URL")

# Optional. Only needed if the project still signs JWTs with the legacy shared
# secret (Project Settings -> API -> JWT Settings). Projects created with
# asymmetric signing keys verify through JWKS and do not need this at all.
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")

# Browsers that may call this API. A wildcard here would let any page on the
# internet make credentialed calls on a signed-in user's behalf.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

# Encrypts the per-user Gemini keys in `user_secrets` (see secrets_store.py).
# A Fernet key: generate one with
#     python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
#
# This never goes in Postgres. The whole point of encrypting the column is
# that a leaked database is not a leaked set of everyone's Google billing,
# and storing the key that opens it in the same database gives that up.
#
# Rotating it makes every stored key unreadable, which the API handles by
# behaving as though nobody had set one -- players re-enter theirs. That is a
# real cost of rotating, and it is the correct behaviour: the alternative is
# guessing.
SECRETS_ENCRYPTION_KEY = os.environ.get("SECRETS_ENCRYPTION_KEY")

# The website's Gemini key: one key, the operator's, spent on behalf of every
# signed-in browser user. Set on Railway; never in the repo.
#
# This used to be deliberately absent, and the reasoning still holds for the
# desktop: a server key read as a silent *fallback* would have every player
# whose own key was missing quietly spending the operator's quota. What
# changed is that the operator decided to pay for the website's AI use
# outright, so the website no longer offers a key box at all (there is
# nothing for one to fall back *from*), and that bill is now the intended
# cost rather than a surprise. The desktop still brings its own key per
# account, exactly as before -- ai.py tells the two apart by the
# X-ForgeQB-Client header the desktop's cloud.py sets, and only a request
# without it ever touches this key.
#
# Because every website user shares it, cap it: in Google AI Studio, set a
# per-day quota on this key rather than leaving it uncapped. The API cannot
# tell an enthusiastic player from a script, and the ceiling is the only
# thing that bounds a bad day.
GEMINI_SHARED_KEY = (os.environ.get("GEMINI_SHARED_KEY") or "").strip() or None


def _int_env(name, default):
    """An integer setting from the environment, falling back on a typo.

    A limit that silently became 0 because someone typed "fifty" would switch
    that limit off, which is the opposite of what anyone editing a limit
    intends. So a bad value keeps the default and says so in the log.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        print(f"{name}={raw!r} is not a whole number; using {default}")
        return default


# Caps on the website's AI usage, all per fixed window -- see ratelimit.py.
# Every website AI call is charged to the operator's key, so these are what
# bound the bill. The desktop is not counted: it spends each account's own
# key. Set any of these to 0 to switch that one limit off.
#
# The defaults are picked against gemini-2.5-flash's free tier, which is a
# few hundred requests a day in total. The global cap is deliberately the
# binding one: the per-user and per-IP caps exist to stop one person or one
# machine eating the whole allowance before anyone else arrives, and the
# global cap is the guarantee that the day's total cannot exceed it however
# many accounts show up. Raise them all once the key is on a paid plan.
AI_LIMIT_USER_PER_HOUR = _int_env("AI_LIMIT_USER_PER_HOUR", 20)
AI_LIMIT_USER_PER_DAY = _int_env("AI_LIMIT_USER_PER_DAY", 60)
AI_LIMIT_IP_PER_DAY = _int_env("AI_LIMIT_IP_PER_DAY", 200)
AI_LIMIT_GLOBAL_PER_DAY = _int_env("AI_LIMIT_GLOBAL_PER_DAY", 400)

JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
JWT_ISSUER = f"{SUPABASE_URL}/auth/v1"
JWT_AUDIENCE = "authenticated"
