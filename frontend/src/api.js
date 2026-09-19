import { supabase } from './supabase.js'

const BASE = import.meta.env.VITE_API_URL

/**
 * Every call to our own API goes through here, so the Authorization header is
 * attached in exactly one place. Scattering `fetch` calls that each remember
 * to add the token is how one of them ends up not remembering.
 *
 * getSession() returns the cached token and refreshes it when it is close to
 * expiring, so this is not a network round trip per request.
 */
async function request(path, { method = 'GET', body, params } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ApiError('You are signed out.', 401)

  const url = new URL(BASE + path)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v))
    else if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  }

  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function call(path, options) {
  const response = await request(path, options)

  // fetch only rejects on a network failure, so a 404 or a 500 arrives here
  // looking exactly like success. Checking response.ok is the whole difference
  // between an error being handled and an error being rendered as data.
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(payload.error ?? 'That request failed.', response.status, payload)
  }
  return payload
}

/**
 * Fetches a file and saves it, for endpoints that answer with a CSV or
 * Markdown body instead of JSON (see web/api/routes/export.py).
 *
 * There is no `<a href>` to point at these: the file lives behind a Bearer
 * token, not a cookie, so a plain link can't carry the Authorization header
 * and the browser would just hit a 401. Fetching it here and handing the
 * bytes to an object URL is the way around that -- the click is real, it's
 * just aimed at a blob this tab already holds instead of at the network.
 */
async function download(path, options) {
  const response = await request(path, options)
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new ApiError(payload.error ?? 'That request failed.', response.status, payload)
  }

  // The server names the file (routes/export.py sets Content-Disposition);
  // falling back to something reasonable rather than failing outright if a
  // proxy ever strips the header, since app.py's CORS config is what makes
  // it readable here at all -- see expose_headers in web/api/app.py.
  const disposition = response.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/)
  const filename = match ? match[1] : 'download'

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on a later turn of the event loop, not immediately after click().
  // The download reads from the object URL asynchronously, so revoking it in
  // the same tick is a race the browser is allowed to lose -- Chrome tends to
  // win it, Firefox has historically not, and losing it means the click does
  // nothing at all with no error to show for it. A minute is far longer than
  // any handoff needs and still frees the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

export class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message)
    this.status = status
    this.payload = payload
    // Distinguishes "the query ran and matched nothing" from a real failure.
    // Retrying the first with the same filters cannot ever work, so the two
    // must not be reported the same way.
    this.empty = Boolean(payload.empty)
  }
}

// The player's own timezone, so the server can cut days on their calendar
// rather than on the region it happens to be deployed in.
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

export const api = {
  filters: () => call('/api/questions/filters'),

  randomQuestion: (filters) => call('/api/questions/random', { params: filters }),

  // The whole set with review status attached -- see routes/questions.py's
  // `browse`. Empty params are dropped by `call`, so an unfiltered browse
  // sends none of them.
  browseQuestions: ({ page, status, q, category }) =>
    call('/api/questions/browse', { params: { page, status, q, category } }),

  submitAnswer: (answer) =>
    call('/api/answers', { method: 'POST', body: { ...answer, timezone } }),

  nextReview: (categories) =>
    call('/api/review/next', { params: { category: categories } }),

  reviewQueue: (page, status, category) =>
    call('/api/review/queue', { params: { page, status, category } }),

  // The four numbers the Review Settings panel opens with, and what is left
  // to drill in each category. One request, because the server groups them.
  reviewCounts: () => call('/api/review/counts'),

  username: () => call('/api/settings/username'),
  saveUsername: (username) =>
    call('/api/settings/username', { method: 'POST', body: { username } }),

  reviewSettings: () => call('/api/settings/review'),
  saveReviewSettings: (settings) =>
    call('/api/settings/review', { method: 'POST', body: settings }),

  addToReview: (questionId) =>
    call('/api/review/add', { method: 'POST', body: { questionId } }),

  removeFromReview: (questionId) =>
    call('/api/review/remove', { method: 'POST', body: { questionId } }),

  // `session` narrows these to one saved Adaptive Learning sitting. Only the
  // three panels built on `user_stats` accept it: a day and a review queue
  // outlive the sitting that produced them, so Retention and Progress take the
  // category and nothing else -- see the note at the top of routes/stats.py.
  stats: (category, session) =>
    call('/api/stats/summary', { params: { category, session, timezone } }),

  // Adaptive Learning. There is no "start a session" call: the server holds no
  // session object to create, so the first question builds the state row and
  // resuming is just loading it -- see web/api/adaptive.py.
  adaptiveCategories: () => call('/api/adaptive/categories'),

  adaptiveQuestion: (categories, weights) =>
    call('/api/adaptive/question', { params: { category: categories, weight: weights } }),

  adaptiveEnd: (restoreKey, sessionId, startedAt, startSkill) =>
    call('/api/adaptive/end', {
      method: 'POST', body: { restoreKey, sessionId, startedAt, startSkill },
    }),

  // The records book. `category` filters the rows and the totals; the picker
  // it is chosen from always lists every category ever played, so a filter
  // can never hide the option that undoes it.
  adaptiveSessions: (category, page) =>
    call('/api/adaptive/sessions', { params: { category, page } }),

  deleteAdaptiveSession: (id) =>
    call(`/api/adaptive/sessions/${id}/delete`, { method: 'POST' }),

  // ---------------------------------------------------------- the notebook --
  notebookCategories: () => call('/api/notebook/categories'),

  notes: (category) => call('/api/notebook/notes', { params: { category } }),
  note: (id) => call(`/api/notebook/notes/${id}`),
  saveNote: (body) => call('/api/notebook/notes', { method: 'POST', body }),
  updateNote: (id, body) => call(`/api/notebook/notes/${id}`, { method: 'POST', body }),
  deleteNote: (id) => call(`/api/notebook/notes/${id}/delete`, { method: 'POST' }),

  mergeGuide: (body) => call('/api/notebook/guides', { method: 'POST', body }),
  appendGuide: (id, body) =>
    call(`/api/notebook/guides/${id}/append`, { method: 'POST', body }),

  flashcards: (category) => call('/api/notebook/flashcards', { params: { category } }),
  saveFlashcards: (body) => call('/api/notebook/flashcards', { method: 'POST', body }),
  deleteFlashcard: (id) =>
    call(`/api/notebook/flashcards/${id}/delete`, { method: 'POST' }),
  deleteAllFlashcards: (category) =>
    call('/api/notebook/flashcards/delete-all', { method: 'POST', body: { category } }),

  clues: (category) => call('/api/notebook/clues', { params: { category } }),
  saveClue: (body) => call('/api/notebook/clues', { method: 'POST', body }),
  deleteClue: (id) => call(`/api/notebook/clues/${id}/delete`, { method: 'POST' }),
  deleteAllClues: (category) =>
    call('/api/notebook/clues/delete-all', { method: 'POST', body: { category } }),

  // The analysis panels. Each returns numbers and a written finding, not
  // a picture -- see web/api/panels.py -- so everything that draws them lives
  // in the browser now, in src/profile.js.
  buzzpoints: (category, session) =>
    call('/api/stats/buzzpoints', { params: { category, session } }),
  ceiling: (category, session) =>
    call('/api/stats/ceiling', { params: { category, session } }),
  negAutopsy: (category, session) =>
    call('/api/stats/negs', { params: { category, session } }),
  retention: (category) => call('/api/stats/retention', { params: { category } }),
  knowledgeDepth: (category) =>
    call('/api/stats/knowledge-depth', { params: { category } }),
  progress: (category, month) =>
    call('/api/stats/progress', { params: { category, month } }),

  // What the Profile's own category filter should offer: only what this
  // account has actually answered, at BOTH levels, with counts. Distinct from
  // `filters()` above, which lists every category in the 169k-question
  // library -- right for the reader's picker, wrong here, because it offers
  // subjects you have never played and those open a blank profile. The
  // desktop has always used this route (`/profile/categories`); the web
  // frontend was still building its filter from the library list.
  playedCategories: () => call('/api/stats/played-categories'),

  // Built for the desktop backfill (see NEXT_SESSION_PROMPT_DESKTOP_CLOUD.md)
  // but never wired into this picker until now -- the routes always existed.
  pointsByCategory: () => call('/api/stats/points-by-category'),
  aggressivePlay: (category, session) =>
    call('/api/stats/aggressive-play', { params: { category, session } }),
  buzzSpread: (category, session) =>
    call('/api/stats/buzz-spread', { params: { category, session } }),
  submissionTime: (category, session) =>
    call('/api/stats/submission-time', { params: { category, session } }),

  // Deletes user_stats and nothing else -- the review queue, the notebook and
  // the Adaptive Learning skill model all survive. See routes/stats.py.
  resetStats: () => call('/api/stats/reset', { method: 'POST' }),

  // ---------------------------------------------------------- AI, per-user --

  explainQuestion: (questionId, userAnswer) =>
    call('/api/ai/explain', { method: 'POST', body: { questionId, userAnswer } }),
  explainSentence: (questionId, sentence) =>
    call('/api/ai/explain-sentence', { method: 'POST', body: { questionId, sentence } }),
  generateFlashcards: (questionId) =>
    call('/api/ai/flashcards', { method: 'POST', body: { questionId } }),
  generateGuide: (category) =>
    call('/api/ai/guide', { method: 'POST', body: { category } }),

  // ----------------------------------------------------------- export/download --
  exportFlashcards: (category) =>
    download('/api/notebook/export/flashcards', { params: { category } }),
  exportSelectedFlashcards: (ids) =>
    download('/api/notebook/export/flashcards', { method: 'POST', body: { ids } }),
  exportNotes: (category) =>
    download('/api/notebook/export/notes', { params: { category } }),
  exportSelectedNotes: (ids) =>
    download('/api/notebook/export/notes', { method: 'POST', body: { ids } }),
}
