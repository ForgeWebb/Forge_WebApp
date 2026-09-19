"""Gemini, called with the key that belongs to whoever is asking.

Two callers, two keys. The **desktop** brings one per account, saved through
Settings and stored encrypted (secrets_store.py) -- the model this module was
built around, described below. The **website** brings none: every browser
user's AI call is made with the operator's own key, `config.GEMINI_SHARED_KEY`,
which the operator pays for. The website has no key box any more, and nothing
a website user has saved (from the desktop, say) is consulted -- it is the
operator's key or nothing.

The two are told apart by `X-ForgeQB-Client: desktop`, the header
`forge_backend/cloud.py` puts on every call it proxies. That is a convention,
not a security boundary (a browser could send it and get itself treated as a
desktop, at which point it would be using its own key, which costs the
operator nothing), and it is the same convention routes/settings.py already
relies on to decide whether to hand a saved key back in the clear.

The desktop keeps one module-level `GeminiGetter` holding one key, because a
desktop app is one process for one person. That shape does not survive a
server: a shared instance whose `key` attribute is reassigned per request is
one thread away from calling Gemini with somebody else's credentials and
billing them for it. The bug would be intermittent, invisible in testing, and
would show up as a stranger's quota being spent.

So a `GeminiGetter` is built **per request**, from the key belonging to the
account that asked. Nothing about the caller's identity is passed in from the
request body: the key is looked up by `g.user_id`, which comes from the
verified token, exactly like every other resource in this API.

The prompts, retry policy, JSON parsing and error wording used to be reused
from `forge_backend/geminiGetter.py` unmodified; that file is now a vendored
copy (`web/api/geminiGetter.py`) for the same reason `rec_logic/` is -- see
adaptive.py's module docstring. Same drift risk, same mitigation (check here
by hand if the desktop's version changes).

Importing geminiGetter has one side effect worth knowing about: it creates
an app-data directory (`~/.config/ForgeQB` on Linux) at import time. Empty
and harmless on a server, but it is a real mkdir, not nothing.
"""

import json
import re
import traceback

from flask import has_request_context, request

from geminiGetter import AIError, GeminiGetter

import config
import secrets_store


class NoKeyConfigured(Exception):
    """This account has not saved a Gemini key yet.

    Its own type because it is the one AI failure that is not an error so much
    as a setup step, and the frontend routes it to "add your key" rather than
    to a red banner.
    """


def _client(api_key):
    """A GeminiGetter bound to exactly one key, for exactly one request.

    `GeminiGetter()` reads `config.json` and then `GEMINI_KEY` from the
    environment on construction, neither of which should decide anything here
    -- so whatever it found is overwritten immediately. `update_api_key` also
    drops the cached genai client, which is what stops a key from outliving
    the request that supplied it.
    """
    getter = GeminiGetter()
    getter.update_api_key(api_key)
    return getter


def verify_key(api_key):
    """(works, problem). Checks a key against Google before it is stored.

    Uses the model *listing* rather than a generation call: it is the cheapest
    thing that still proves the key is real and enabled, and it does not spend
    the player's tokens to find out whether they typed their key correctly.
    """
    try:
        from google import genai
        # The client is bound to a name on purpose. `genai.Client(...).models
        # .list()` builds the client as a temporary, and it can be garbage
        # collected the moment `.models` has been read -- its `__del__` closes
        # the underlying httpx pool, and the call then dies with "Cannot send
        # a request, as the client has been closed." It fails only under
        # timing that makes the collection land mid-call, so it looks like an
        # intermittent network fault rather than a lifetime bug.
        client = genai.Client(api_key=api_key)
        client.models.list()
        return True, None
    except Exception as e:
        text = str(e).lower()
        if "api key not valid" in text or "api_key_invalid" in text or "400" in text:
            return False, "Google rejected that key. Check you copied all of it."
        if "permission" in text or "403" in text:
            return False, ("That key exists but is not allowed to use the "
                           "Gemini API. Enable the Generative Language API for it.")
        # The message goes to the log, not to the caller -- a provider's raw
        # exception text is exactly the kind of thing that leaks internals.
        traceback.print_exc()
        return False, f"Could not reach Google to check that key: {type(e).__name__}"


def is_website_request():
    """True when the current request came from a browser, not the desktop.

    Read off the request, so it has to be called *on* the request thread. A
    caller that goes on to do AI work somewhere else -- routes/stats.py names
    clusters on a background thread -- must call this first and carry the
    answer across, because off the request thread there is no header to read
    and the honest answer is "no idea", not "website".
    """
    if not has_request_context():
        raise RuntimeError("is_website_request() called outside a request")
    return request.headers.get("X-ForgeQB-Client") != "desktop"


def for_user(conn, user_id, *, website):
    """The GeminiGetter for this call, or raise NoKeyConfigured.

    `website` decides whose key: the operator's shared one for the website,
    this account's own saved one for the desktop. It is a required keyword
    rather than a default so a new call site has to say which it is -- the
    wrong default here is a wrong bill, quietly, and not the kind that shows
    up in a test.
    """
    if website:
        if not config.GEMINI_SHARED_KEY:
            # The operator has not set the key on the server. There is no
            # box for the player to fix this from, so the message says
            # whose problem it is.
            raise NoKeyConfigured(
                "AI features aren't switched on for the website right now.")
        return _client(config.GEMINI_SHARED_KEY)

    key = secrets_store.load_gemini_key(conn, user_id)
    if not key:
        raise NoKeyConfigured(
            "Add your own Gemini API key in Settings to use the AI features.")
    return _client(key)


def extract_flashcard_json(raw_response):
    """Pull the flashcard array out of whatever the model actually sent.

    **A copy of `extract_flashcard_json` in merged_api.py, and it should not
    have to be.** The function is pure -- `re` and `json` and nothing else --
    but it lives in a module that builds a Flask app and opens a sqlite
    connection at import time, so importing it here would drag the whole
    desktop backend into the web server. Same trap, same reason, and the same
    de-duplication debt already recorded for `answerline.py` in
    web/README.md section 6: the fix is to lift it into a shared module both
    builds import, not to keep two copies indefinitely. `adaptive.py` and the
    Gemini prompts above are the counter-example -- those import cleanly and
    so were *not* copied.

    The prompt asks for a bare JSON array, but models routinely wrap it in
    code fences or bracket it with chat ("Here are the flashcards:" / "Let me
    know if you want more!"). Stripping only the exact string "```json" left
    all of those unparseable, and the user saw "the AI returned an invalid
    format" for a response that contained perfectly good cards.

    Returns a list of {term, definition} dicts, dropping malformed entries.
    """
    text = (raw_response or "").strip()
    text = re.sub(r"```[a-zA-Z]*", "", text).strip()

    candidate = None
    start = text.find("[")
    if start != -1:
        # Walk to the matching bracket so trailing chatter is ignored, and
        # brackets inside string values don't end the scan early.
        depth, in_str, escaped = 0, False, False
        for i, ch in enumerate(text[start:], start):
            if in_str:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    candidate = text[start:i + 1]
                    break

    if candidate is None:
        # A single object is still usable as a one-card deck.
        obj_start, obj_end = text.find("{"), text.rfind("}")
        if obj_start != -1 and obj_end > obj_start:
            candidate = f"[{text[obj_start:obj_end + 1]}]"
        else:
            candidate = text

    parsed = json.loads(candidate)
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []

    cards = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        term = str(item.get("term") or "").strip()
        definition = str(item.get("definition") or "").strip()
        if term and definition:
            cards.append({"term": term, "definition": definition})
    return cards


__all__ = ["AIError", "NoKeyConfigured", "for_user", "is_website_request",
           "verify_key", "extract_flashcard_json"]
