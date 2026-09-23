from google import genai
import os
import json
import random
import time
import traceback
from dotenv import load_dotenv
import platform


class AIError(Exception):
    """Raised when an AI request fails, carrying a user-readable reason."""
    pass


def _is_transient(exc):
    """True when retrying the same request has a real chance of working.

    Gemini returns 503 UNAVAILABLE whenever the model is busy ("experiencing
    high demand"). It is not a problem with the request, the key, or the
    question - the same call usually succeeds a second or two later.
    """
    text = str(exc).lower()
    transient_markers = (
        "unavailable", "503", "overloaded", "high demand",
        "internal", "500", "502", "504", "deadline", "timed out", "timeout",
    )
    # A rejected key or an exhausted quota will fail identically on a retry.
    if any(m in text for m in ("api key", "api_key", "unauthenticated", "permission denied")):
        return False
    return any(m in text for m in transient_markers)


def _friendly_ai_error(exc):
    """The message a user should see for a failed AI request.

    Deliberately says nothing about the provider, status codes, or why the
    service declined. Users don't benefit from "503 UNAVAILABLE" or which
    vendor is behind the feature - it reads like a crash and invites doubt in
    the app. The full exception is still printed to the log for debugging.

    The only exceptions are problems the user must act on themselves: a
    missing or rejected API key, and a spent quota. Those name the setting to
    fix, because nothing else will resolve them.
    """
    text = str(exc).lower()
    if "api key" in text or "api_key" in text or "unauthenticated" in text or "permission" in text:
        return "Your API key was rejected. Check it in Settings."
    if "quota" in text or "rate limit" in text or "resource_exhausted" in text or "429" in text:
        return "You've hit the AI usage limit for now. Try again later."
    # A retired or misnamed model. Its own branch because it went undiagnosed
    # for an afternoon behind the catch-all below: Google retired
    # gemini-2.5-flash "for new users", so a new key got a 404 naming the
    # replacement model, and every AI feature reported "Couldn't generate
    # that. Try again." -- which reads as a transient fault and invites
    # exactly the retry that cannot ever work. The model name is a setting
    # now (see DEFAULT_MODEL), so this is a thing an operator can act on.
    if "not_found" in text or "404" in text or "is no longer available" in text:
        return ("The AI model this app asks for is not available. It has "
                "probably been retired - see the log for the replacement "
                "Google names, and set GEMINI_MODEL to it.")
    if "deadline" in text or "timeout" in text or "connection" in text or "network" in text:
        return "Couldn't connect. Check your internet connection."
    # Everything else - busy models, server errors, malformed replies - is the
    # same thing from the user's point of view: it didn't work, try again.
    return "Couldn't generate that. Try again."

def get_app_data_dir():
    if platform.system() == "Windows":
        return os.path.join(os.environ["APPDATA"], "ForgeQB")
    elif platform.system() == "Darwin": # macOS
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "ForgeQB")
    else: # Linux
        return os.path.join(os.path.expanduser("~"), ".config", "ForgeQB")

APP_DATA_DIR = get_app_data_dir()
if not os.path.exists(APP_DATA_DIR):
    os.makedirs(APP_DATA_DIR)

class GeminiGetter:
    CONFIG_FILE = os.path.join(APP_DATA_DIR, 'config.json')

    # A 503 means the model is busy, so a couple of quick retries usually
    # turns a visible failure into a slightly slower success.
    MAX_ATTEMPTS = 3
    RETRY_BASE_DELAY = 0.8

    # Which model to ask. Overridable by environment (GEMINI_MODEL) or by
    # config.json, because the name is the one thing here that goes stale
    # without any code being wrong: Google renames and retires models on its
    # own schedule, and a retired name fails every AI feature at once. Being
    # a setting means a swap is a Railway variable on the web side and a
    # config edit on the desktop -- not a code change, and in particular not
    # a full PyInstaller rebuild and re-release of the desktop app.
    #
    # It also matters for the newer AQ.-prefixed API keys, which older models
    # reportedly do not accept.
    # Changed from gemini-2.5-flash on 2026-09-23, because Google closed it:
    #
    #   404 NOT_FOUND: This model models/gemini-2.5-flash is no longer
    #   available to new users. Please update your code to use
    #   models/gemini-3.6-flash
    #
    # Note "to new users". Keys that already had access kept working, so this
    # broke in the least visible way possible: every existing desktop user was
    # fine, and only a freshly created key saw the 404 -- which is exactly
    # what a new website deployment and every new install is. It also arrived
    # as the generic "Couldn't generate that. Try again.", a retired model not
    # being one of the causes _friendly_ai_error knew about; it is now.
    #
    # The oldest Flash model still open, deliberately, and not a "-lite" one.
    # Aaron's call, to stay off whatever the newest model's quota costs: the
    # website runs every user's AI on one key, so the cheapest adequate model
    # is the one that keeps that key alive longest. 3.5-flash is the oldest
    # non-lite Flash on the current list (3.8, 3.7, 3.6, 3.5, then only
    # lite variants below that).
    #
    # Worth knowing if this is revisited: Google does not publish per-model
    # free-tier limits, so "older is cheaper" is an assumption, not a
    # measured fact -- the real numbers are per-account, at
    # aistudio.google.com/rate-limit. And an older model is the one more
    # likely to be closed next, exactly as 2.5-flash just was. If AI starts
    # failing with a 404 again, this is the first thing to move forward.
    DEFAULT_MODEL = "models/gemini-3.5-flash"

    def __init__(self):
        self._client = None
        self._client_key = None
        self.key = self._load_key()
        self.model = self._load_model()
        if self.key:
            self.update_api_key(self.key)

    def _load_model(self):
        """The model name, from config.json, then the environment, then the
        default. Same order as the key, and guarded the same way -- a
        malformed config must not stop the backend from starting.

        Accepts a bare name ("gemini-3-flash") as well as a fully qualified
        one; the API wants the "models/" prefix, so one is added if missing
        rather than having every caller remember it.
        """
        name = None
        if os.path.exists(self.CONFIG_FILE):
            try:
                with open(self.CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)
                if isinstance(config, dict):
                    name = config.get("GEMINI_MODEL")
            except Exception:
                pass    # _load_key already reported an unreadable config
        name = (name or os.getenv("GEMINI_MODEL") or "").strip()
        if not name:
            return self.DEFAULT_MODEL
        return name if name.startswith("models/") else f"models/{name}"

    def _get_client(self):
        """Reuse one client per key instead of building one per request."""
        if self._client is None or self._client_key != self.key:
            self._client = genai.Client(api_key=self.key)
            self._client_key = self.key
        return self._client

    def _load_key(self):
        # First, try to load from config file (for packaged app).
        #
        # Guarded because this runs from __init__, which merged_api calls at
        # module level - so an unreadable config.json used to raise during
        # import and stop the backend from starting at all. A missing key just
        # means the AI features are off until one is entered; that is a state
        # the app already handles, and it is a far better outcome than a
        # backend that won't boot. merged_api.load_config() carries the same
        # guard and is what moves the bad file aside.
        if os.path.exists(self.CONFIG_FILE):
            try:
                with open(self.CONFIG_FILE, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                if isinstance(config, dict):
                    key = config.get("GEMINI_KEY")
                    if key:
                        return key
            except Exception as e:
                print(f"Could not read the API key from config.json "
                      f"({type(e).__name__}: {e}); falling back to the environment")

        # Fallback to .env file (for local development)
        load_dotenv()
        return os.getenv("GEMINI_KEY")

    def update_api_key(self, api_key):
        self.key = api_key
        # Drop the cached client so the next call picks up the new key
        self._client = None
        self._client_key = None

    instruction_dict = {
        # No longer opens with the answerline as its own heading -- Get
        # Explanation is available before a tossup is even buzzed on (the web
        # port now gates the *button* on the tossup being over, but this
        # prompt is shared with the desktop build and with the sentence-level
        # explain path, and a giant "# Black Sea" is a spoiler in any of them
        # if something ever calls this early). Titling a saved note no longer
        # depends on this either -- routes/notebook.py's save_note reads the
        # real answerline off source_question_id now, not off this text.
        "explain": "Explain the following quizbowl question in context of its answer. Do not write any preamble such as \"Here's an explanation\" - go straight into the clues. For each clue, briefly describe its relevance to the answer, name any referenced works, people, or concepts, and clarify connections. Mention the answer naturally as part of the explanation rather than announcing it up front. Use concise bullet points for each clue. If you cannot answer, respond with a short error message only.\n",
        "card": "\nFrom the following quizbowl question, generate a JSON array of flashcard objects.\nEach object must have a \"term\" and a \"definition\" key.\nThe \"term\" should be a specific, important clue from the question.\nThe \"definition\" should be the answer to that clue.\nYour response MUST be a valid JSON array and nothing else. Do not include any explanatory text, markdown formatting like ```json, or any other characters before or after the array.\n\nExample of a valid response:\n[{\"term\": \"This author wrote 'The School for Wives'\", \"definition\": \"Molière\"}, {\"term\": \"This play features the character Arnolphe\", \"definition\": \"The School for Wives\"}]\n\nHere is the question:\n",
        "notes": "\nYou are a hybrid scholar and veteran quizbowl question writer. Your mission is to construct a dense, thematically consistent knowledge web based on a specific set of clues.\nYour output must be well-organized, comprehensive, and formatted using Markdown for clarity.\nThe goal is to create a structured, easy-to-review study guide that provides insights beyond simple definitions.\nHere are the clues:\n",
        "explain_sentence": "\nYou are an AI tutor. For the following quizbowl clue, provide a brief insight that a user would need to research beyond the tossup. I want you to provide this research for the user. Identify and name any works, authors, historical events, scientific concepts, people, or places referenced. Describe the context and significance in 1-2 sentences, focusing on what makes the clue important. Do not just reword the clue—add extra information that connects the clue to its broader context, regardless of the academic field.\n\nClue: \"{sentence}\"\nAnswer: \"{answer}\"\n",
        # Category-specific prompts
        "science": "For science questions, focus on identifying the scientific concept, discovery, experiment, or law referenced. Name the scientist(s), year, country, and describe the significance, mechanism, or application. Include related terms, equations, and historical context if relevant. Use concise bullet points for each clue.",
        "history": "For history questions, identify the event, battle, year, war, generals, leaders, countries, and outcomes. Describe the historical context, causes, and consequences. Name any treaties, locations, and important dates. Use bullet points for each clue and clarify connections to broader historical trends.",
        "literature": "For literature questions, name the author, country, literary work, genre, and notable quotes. Identify characters, plot points, and literary devices. Describe the significance of the work, its influence, and any relevant historical or cultural context. Use bullet points for each clue.",
        "arts": "For arts questions, specify the artist, artwork, style, period, and technique. Name museums, locations, and influences. Describe the significance of the piece and its impact on art history. Use bullet points for each clue.",
        "geography": "For geography questions, identify the country, city, region, landmark, or feature. Name any relevant historical events, population facts, and cultural details. Use bullet points for each clue.",
        "current_events": "For current events, name the people, organizations, countries, and dates involved. Describe the event, its causes, and consequences. Use bullet points for each clue and clarify its relevance to global trends.",
    }

    def _generate_content(self, prompt):
        """Return generated text, or raise AIError describing what went wrong.

        Callers need to tell "no API key" apart from "quota exceeded" apart
        from "network down" - previously every failure came back as the same
        plain string, which callers then tried to parse as JSON and reported
        as an unrelated "invalid format" error.
        """
        if not self.key:
            raise AIError("API key not configured. Add your Gemini API key in Settings.")

        client = self._get_client()
        last_exc = None
        for attempt in range(self.MAX_ATTEMPTS):
            try:
                response = client.models.generate_content(
                    model=self.model,
                    contents=prompt
                )
            except Exception as e:
                last_exc = e
                if attempt < self.MAX_ATTEMPTS - 1 and _is_transient(e):
                    # Back off with jitter so a busy model isn't hammered by
                    # every client retrying on the same schedule.
                    delay = self.RETRY_BASE_DELAY * (2 ** attempt) + random.uniform(0, 0.3)
                    print(f"Gemini attempt {attempt + 1} failed ({type(e).__name__}); "
                          f"retrying in {delay:.1f}s")
                    time.sleep(delay)
                    continue
                print(f"Gemini request failed: {type(e).__name__}: {e}")
                traceback.print_exc()
                raise AIError(_friendly_ai_error(e)) from e

            # `.strip()`, not just truthiness: a body of "\n\n" is truthy, so
            # it was returned as a successful generation and saved as the
            # content of a note or a flashcard. Blank output is not an answer,
            # and every caller here writes what it gets straight to the
            # database - so this is the one place that can stop a blank guide
            # from existing, rather than each save path learning to spot one.
            text = getattr(response, "text", None)
            if text and text.strip():
                return text

            # An empty body is transient in the same way a 503 is.
            last_exc = RuntimeError("empty response")
            if attempt < self.MAX_ATTEMPTS - 1:
                time.sleep(self.RETRY_BASE_DELAY * (2 ** attempt))
                continue

        raise AIError(_friendly_ai_error(last_exc) if last_exc else
                      "The AI returned an empty response. Please try again.")

    def get_question_explanation(self, question_text, answer_text, user_answer=""):
        # The simple prompt doesn't need fancy formatting, just the question and answer.
        query = f"Question: {question_text}\nAnswer: {answer_text}"
        prompt = self.instruction_dict["explain"] + query
        return self._generate_content(prompt)

    def get_sentence_explanation(self, sentence, answer):
        prompt = self.instruction_dict['explain_sentence'].format(
            sentence=sentence,
            answer=answer
        )
        return self._generate_content(prompt)

    def get_notes_from_clues(self, clues_text):
        # instruction_dict['notes'] already ends with "Here are the clues:\n",
        # so prepending it again made every study-guide prompt say it twice.
        prompt = f"{self.instruction_dict['notes']}{clues_text}"
        results = self._generate_content(prompt)
        return results

    def create_flashcards(self, question_text):
        prompt = self.instruction_dict['card'] + question_text
        return self._generate_content(prompt)

    def name_topic_clusters(self, groups):
        """Give each topic cluster a short human name.

        `groups` is [{"id": str, "answers": [str, ...]}, ...]; returns
        {id: "American poets"}.

        The clusters come out of k-means over question embeddings, so they are
        integers with no name. The previous approach picked the three answers
        whose vocabulary overlapped most with the rest of the cluster and used
        those *as* the label - which is how a group of American poetry ended up
        displayed as "Robert Lee Frost, Sylvia Plath, Emily Dickinson". Word
        frequency can only ever return answers that are already in the data; it
        cannot produce the words "American poets", because that phrase appears
        in none of them.

        **All of them go in one request.** A player has a handful of clusters,
        and one call that names every one of them is the difference between a
        profile page that opens and one that waits on a dozen round trips.
        """
        if not groups:
            return {}
        lines = []
        for g in groups:
            answers = ", ".join(str(a) for a in g["answers"][:12])
            lines.append(f'{g["id"]}: {answers}')
        prompt = (
            "Each line below is a group of quizbowl answers that were clustered "
            "together because they are about similar things. The line starts with "
            "an id, then a colon, then example answers from that group.\n\n"
            "For each id, give a SHORT topic name for the group - 2 to 4 words, "
            "the kind of heading a student would write on a study sheet. Examples "
            "of good names: 'American poets', 'Russian novelists', 'Cell "
            "organelles', 'Baroque painters', 'Greek myth heroes'.\n\n"
            "Do not list the answers back. Do not name a single specific person or "
            "work unless the whole group really is about only that one thing. If a "
            "group is genuinely mixed with no common theme, name it 'Mixed topics'.\n\n"
            "Reply with one line per id, in the form:\n"
            "id | topic name\n\n"
            "Nothing else - no preamble, no numbering, no markdown.\n\n"
            + "\n".join(lines)
        )
        raw = self._generate_content(prompt)

        # Parse defensively: the reply is short and the shape is simple, but a
        # model that adds a preamble or bullets shouldn't cost us every label.
        out = {}
        valid = {str(g["id"]) for g in groups}
        for line in (raw or "").splitlines():
            line = line.strip().lstrip("-*# ").strip()
            if "|" not in line:
                continue
            key, _, name = line.partition("|")
            key, name = key.strip(), name.strip().strip('"\'')
            if key in valid and name:
                # Guard against the model ignoring the length instruction and
                # echoing the answer list back as the "name".
                out[key] = name if len(name) <= 40 else name[:37] + "..."
        return out
