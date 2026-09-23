"""AI features: one GeminiGetter per request, built from the caller's own key.

Three of four now. Explanations proved `ai.for_user()` -> a real Gemini call
-> a real response works end to end; flashcard and study-guide generation
below are built on the same shape. Knowledge Depth (naming a player's topic
clusters) is not here -- it needs its own per-cluster accuracy panel built
first, which nothing in panels.py does yet, and bolting the naming call onto
a panel that doesn't exist would be building the smaller half of a bigger
feature.

Same rule as every other route here: **anything that decides what Gemini is
asked about is read off the database, never trusted from the request body.**
The question and its answer come from `public.questions` by id, and the
clues a study guide is built from come from this account's own `user_clues`
rows -- never from a request body, which is what stops a client from getting
Gemini to write about arbitrary text at this account's expense.
"""

from flask import Blueprint, g, jsonify, request

import ai
import db
import notebook
import ratelimit
from answerline import clean_answerline
from auth import require_user

bp = Blueprint("ai", __name__, url_prefix="/api/ai")

MAX_FLASHCARDS_PER_GENERATION = 50


def _question_and_answer(conn, question_id):
    return conn.execute(
        "select id, question, answer from public.questions where id = %s",
        (question_id,)).fetchone()


def _getter_or_error(conn):
    """(getter, error_response). error_response is None on success.

    `ai.NoKeyConfigured` is not a server failure -- on the desktop it means
    this account hasn't pasted a key into Settings yet; on the website it
    means the operator hasn't set the shared key -- so it comes back as a 400
    with a `code` the frontend can switch on, rather than the generic error
    banner every other failure gets.
    """
    try:
        return ai.for_user(conn, g.user_id, website=ai.is_website_request()), None
    except ai.NoKeyConfigured as e:
        return None, (jsonify({"error": str(e), "code": "no_key"}), 400)


def _ai_error(e):
    """A 502 carrying a message that fits whoever is reading it.

    geminiGetter's wording assumes the reader owns the key and can go and fix
    it in Settings -- true on the desktop, and it is the desktop's copy of
    that file, so it stays as it is. On the website the key belongs to the
    operator and the reader has no Settings box to check (there isn't one any
    more), so "check it in Settings" sends them somewhere that does not
    exist. Rewritten here, at the boundary that knows which app is asking,
    rather than by making the shared file take a caller argument.
    """
    text = str(e)
    lowered = text.lower()
    # Two kinds of failure are the operator's to fix and nobody else's: a
    # rejected key, and a model name that no longer exists. geminiGetter's
    # wording for both names the setting to change, which is right for the
    # desktop (its own copy, its own key, its own config) and useless on the
    # website, where the reader owns neither and has no Settings box to look
    # at. The real message is in the server log, where the operator will
    # find it.
    if ai.is_website_request() and ("api key" in lowered or "model" in lowered):
        text = ("The website's AI isn't set up correctly right now. This is "
                "not something you can fix - try again later.")
    return jsonify({"error": text}), 502


@bp.post("/explain")
@require_user
@ratelimit.limit_website_ai
def explain():
    """A whole-tossup explanation, clue by clue."""
    payload = request.get_json(silent=True) or {}
    question_id = payload.get("questionId")
    if not isinstance(question_id, int):
        return jsonify({"error": "questionId is required."}), 400
    user_answer = (payload.get("userAnswer") or "").strip()

    # Read (short transaction), then call Gemini with no transaction open --
    # the same shape answers.py uses, and for the same reason: a network call
    # held inside a Postgres transaction pins a pooled connection for however
    # long Gemini takes to answer.
    with db.user_tx(g.user_id) as conn:
        row = _question_and_answer(conn, question_id)
        if row is None:
            return jsonify({"error": "No question with that id."}), 404
        getter, error = _getter_or_error(conn)
        if error:
            return error

    try:
        explanation = getter.get_question_explanation(
            question_text=row["question"], answer_text=row["answer"],
            user_answer=user_answer)
    except ai.AIError as e:
        return _ai_error(e)

    return jsonify({"explanation": explanation})


@bp.post("/explain-sentence")
@require_user
@ratelimit.limit_website_ai
def explain_sentence():
    """One clue, explained mid-read -- same shape, a smaller prompt."""
    payload = request.get_json(silent=True) or {}
    question_id = payload.get("questionId")
    sentence = (payload.get("sentence") or "").strip()
    if not isinstance(question_id, int):
        return jsonify({"error": "questionId is required."}), 400
    if not sentence:
        return jsonify({"error": "No sentence provided."}), 400

    with db.user_tx(g.user_id) as conn:
        row = _question_and_answer(conn, question_id)
        if row is None:
            return jsonify({"error": "No question with that id."}), 404
        getter, error = _getter_or_error(conn)
        if error:
            return error

    try:
        explanation = getter.get_sentence_explanation(sentence, row["answer"])
    except ai.AIError as e:
        return _ai_error(e)

    return jsonify({"explanation": explanation})


@bp.post("/flashcards")
@require_user
@ratelimit.limit_website_ai
def generate_flashcards():
    """Draft flashcards from one tossup. Returned, not saved.

    Generation and saving stay two steps, matching the desktop's
    `/createFlashcard` -> a separate save. A card the model produced is a
    draft: nothing here writes to `flashcards` until the existing
    `POST /api/notebook/flashcards` is called with whichever of these the
    player actually wants kept -- Gemini's output does not get to skip the
    "half a card is not a card" filtering that endpoint already does.
    """
    payload = request.get_json(silent=True) or {}
    question_id = payload.get("questionId")
    if not isinstance(question_id, int):
        return jsonify({"error": "questionId is required."}), 400

    with db.user_tx(g.user_id) as conn:
        row = _question_and_answer(conn, question_id)
        if row is None:
            return jsonify({"error": "No question with that id."}), 404
        getter, error = _getter_or_error(conn)
        if error:
            return error

    try:
        raw = getter.create_flashcards(row["question"])
    except ai.AIError as e:
        return _ai_error(e)

    try:
        cards = ai.extract_flashcard_json(raw)
    except ValueError:
        # json.loads raises this on a response with no parseable JSON in it
        # at all -- the model apologised instead of answering. Not a 502: the
        # call to Gemini succeeded, it simply declined the request.
        cards = []

    if not cards:
        return jsonify({
            "error": "The AI didn't return any usable flashcards. Try again."}), 502

    return jsonify({"cards": cards[:MAX_FLASHCARDS_PER_GENERATION]})


@bp.post("/guide")
@require_user
@ratelimit.limit_website_ai
def generate_guide():
    """A study guide, built from this account's saved clues and saved as a note.

    Generation and saving are one step here, unlike flashcards above -- the
    desktop's `/generateNotes` writes the guide as soon as Gemini returns it,
    and there is nothing to preview: a clue that was worth saving with Save
    Highlight is presumably worth keeping in the guide it produces, where a
    generated flashcard is disposable draft the desktop always let you
    discard. Ported the same way the split itself was: kept, not re-decided.

    **Three phases, not one transaction.** This route used to hold the
    connection open across the Gemini call, unlike its three siblings above --
    which is the mistake their own comments exist to warn about, and it is
    worst here: a guide is built from *every* clue the account has saved, so
    it is the longest-running model call in the app, and there is no timeout
    on it. The pool is eight connections (`db.py`), so eight concurrent guide
    generations would pin all of them and stall every other request in the
    API, including ones that have nothing to do with the notebook. Same shape
    `routes/stats.py`'s `knowledge_depth` already uses: read, call, write.
    """
    payload = request.get_json(silent=True) or {}
    category = (payload.get("category") or "").strip()
    if not category:
        return jsonify({"error": "A category is required."}), 400

    everything = category.lower() == "all"

    # ------------------------------------------- phase 1: read (short tx) ---
    # `resolve_bare_category` runs here too rather than after the model call,
    # so the second transaction below is nothing but the insert. It reads the
    # shared question set, which the Gemini response cannot change.
    with db.user_tx(g.user_id) as conn:
        if everything:
            clues = conn.execute(
                "select clue_text, answer_text from public.user_clues "
                "where user_id = %s order by created_at desc",
                (g.user_id,)).fetchall()
        else:
            clues = conn.execute(
                "select clue_text, answer_text from public.user_clues "
                "where user_id = %s and category = %s order by created_at desc",
                (g.user_id, category)).fetchall()

        if not clues:
            scope = "" if everything else f" in {category}"
            return jsonify({
                "empty": True,
                "error": f"No saved clues{scope} yet. While reading a tossup, "
                         "highlight a clue worth keeping and press Save "
                         "Highlight -- this builds a guide out of everything "
                         "you've saved.",
            }), 404

        getter, error = _getter_or_error(conn)
        if error:
            return error

        # "all" is not a real shelf -- resolve_bare_category would file it
        # under a category literally named "all". The clues themselves came
        # from as many real categories as the player has saved to, so there
        # is no single one to file an "all" guide under; General is the same
        # honest fallback the desktop's own bare-save path uses.
        filed_category, subcategory = (
            (None, None) if everything
            else notebook.resolve_bare_category(conn, category))
        filed_category = filed_category or "General"

    # ------------------------------- phase 2: the model call, no tx open ---
    formatted = [f"Clue: {row['clue_text']}\nAnswer: {row['answer_text']}"
                 for row in clues]
    try:
        content = getter.get_notes_from_clues("\n".join(formatted))
    except ai.AIError as e:
        return _ai_error(e)

    answer_text = notebook.derive_title_from_content(content)
    if notebook.looks_like_intro_sentence(answer_text):
        answer_text = None
    answer_text = clean_answerline(answer_text) or None

    # ------------------------------------------ phase 3: write (short tx) ---
    with db.user_tx(g.user_id) as conn:
        note = conn.execute(
            """insert into public.notebook_notes
                   (user_id, notes_content, category, subcategory, answer_text)
               values (%s, %s, %s, %s, %s)
            returning id, notes_content, category, subcategory, answer_text,
                      created_at""",
            (g.user_id, content, filed_category, subcategory,
             answer_text)).fetchone()

    return jsonify(dict(note)), 201
