import { supabase, setRememberMe } from './supabase.js'
import { api, ApiError } from './api.js'
import { initProfile } from './profile.js'
import { initNotebook } from './notebook.js'
import { initRecords } from './records.js'
import { initReviewSettings } from './reviewSettings.js'
import { initReviewList } from './reviewList.js'
import { initBrowse } from './browse.js'
import { initAccountSettings } from './accountSettings.js'
import { renderMarkdown } from './markdown.js'
import * as voice from './voice.js'

// ---------------------------------------------------------------- elements --

const $ = (id) => document.getElementById(id)
const el = {
  authScreen: $('authScreen'), authForm: $('authForm'), authMessage: $('authMessage'),
  email: $('email'), password: $('password'), rememberMe: $('rememberMe'),
  signInBtn: $('signInBtn'), signUpBtn: $('signUpBtn'), forgotPasswordBtn: $('forgotPasswordBtn'),
  recoveryForm: $('recoveryForm'), recoveryPassword: $('recoveryPassword'),
  setNewPasswordBtn: $('setNewPasswordBtn'),
  appScreen: $('appScreen'), whoami: $('whoami'), signOutBtn: $('signOutBtn'),
  readerScreen: $('readerScreen'), profileScreen: $('profileScreen'),
  aboutScreen: $('aboutScreen'), adaptiveSetupScreen: $('adaptiveSetupScreen'),
  notebookHubScreen: $('notebookHubScreen'),
  notebookDetailScreen: $('notebookDetailScreen'),
  recordsScreen: $('recordsScreen'), reviewListScreen: $('reviewListScreen'),
  profileBtn: $('profileBtn'), backToReaderBtn: $('backToReaderBtn'),
  aboutBtn: $('aboutBtn'), backFromAboutBtn: $('backFromAboutBtn'),
  notebookBtn: $('notebookBtn'), saveHighlightBtn: $('saveHighlightBtn'),
  recordsBtn: $('recordsBtn'), reviewSettingsBtn: $('reviewSettingsBtn'),

  settingsBtn: $('settingsBtn'), settingsModal: $('settingsModal'),
  closeSettingsBtn: $('closeSettingsBtn'),
  fontSizeRange: $('fontSizeRange'), fontSizeDisplay: $('fontSizeDisplay'),
  fontSizeResetBtn: $('fontSizeResetBtn'), shortcutsToggle: $('shortcutsToggle'),
  shortcutListSettings: $('shortcutListSettings'), shortcutListAbout: $('shortcutListAbout'),
  shortcutToast: $('shortcutToast'),

  adaptiveLearningBtn: $('adaptiveLearningBtn'),
  adaptiveCategorySelect: $('adaptiveCategorySelect'),
  adaptiveWeightsWrap: $('adaptiveWeightsWrap'), adaptiveWeights: $('adaptiveWeights'),
  adaptiveWeightTotal: $('adaptiveWeightTotal'),
  resetAdaptiveWeightsBtn: $('resetAdaptiveWeightsBtn'),
  startAdaptiveSessionBtn: $('startAdaptiveSessionBtn'),
  cancelAdaptiveBtn: $('cancelAdaptiveBtn'), adaptiveSetupMessage: $('adaptiveSetupMessage'),
  adaptiveSessionStats: $('adaptiveSessionStats'),
  adaptiveSubject: $('adaptiveSubject'), adaptiveSkill: $('adaptiveSkill'),
  adaptiveAnswered: $('adaptiveAnswered'), adaptiveCorrect: $('adaptiveCorrect'),
  adaptiveAccuracy: $('adaptiveAccuracy'), adaptiveResumed: $('adaptiveResumed'),
  saveAndQuitAdaptiveBtn: $('saveAndQuitAdaptiveBtn'),
  profileCategoryFilter: $('profileCategoryFilter'),
  profileTossupsHeard: $('profileTossupsHeard'), profilePoints: $('profilePoints'),
  profilePowers: $('profilePowers'), profileTens: $('profileTens'),
  profileNegs: $('profileNegs'), profileCelerity: $('profileCelerity'),
  statAboutTitle: $('statAboutTitle'), statAboutWhat: $('statAboutWhat'),
  statAboutFinding: $('statAboutFinding'),
  statPicker: $('statPicker'), statSubPicker: $('statSubPicker'), statView: $('statView'),
  progressNav: $('progressNav'), progressViewPicker: $('progressViewPicker'),
  progressChartView: $('progressChartView'), progressTableView: $('progressTableView'),
  profileTitle: $('profileTitle'), profileCategoryLabel: $('profileCategoryLabel'),
  progressSection: $('progressSection'),
  profileSessionNotice: $('profileSessionNotice'),
  profileSessionText: $('profileSessionText'),
  profileExitSessionBtn: $('profileExitSessionBtn'),
  resetStatsBtn: $('resetStatsBtn'), resetStatsModal: $('resetStatsModal'),
  confirmResetStatsBtn: $('confirmResetStatsBtn'),
  cancelResetStatsBtn: $('cancelResetStatsBtn'),
  resetStatsMessage: $('resetStatsMessage'),

  categorySelect: $('categorySelect'), subcategorySelect: $('subcategorySelect'),
  subcategoryWrapper: $('subcategoryWrapper'), difficultySelect: $('difficultySelect'),
  yearRangeWrapper: $('yearRangeWrapper'), yearRangeLabel: $('yearRangeLabel'),
  yearMin: $('yearMin'), yearMax: $('yearMax'),

  powerHighlightToggle: $('powerHighlightToggle'), allowRebuzzToggle: $('allowRebuzzToggle'),
  readingSpeed: $('readingSpeed'), speedDisplay: $('speedDisplay'),
  voiceModeToggle: $('voiceModeToggle'), showTextRow: $('showTextRow'),
  showTextToggle: $('showTextToggle'), voiceUnsupported: $('voiceUnsupported'),

  getNewQuestionBtn: $('getNewQuestionBtn'), getManyQuestionsBtn: $('getManyQuestionsBtn'),
  reviewMissedBtn: $('reviewMissedBtn'), stopReviewBtn: $('stopReviewBtn'),
  pauseBtn: $('pauseBtn'),

  ptn: $('ptn'), tossupsHeard: $('tossupsHeard'), pointsScored: $('pointsScored'),
  celerity: $('celerity'),

  questionContainer: $('questionContainer'), questionMeta: $('questionMeta'),
  reviewAheadNotice: $('reviewAheadNotice'),
  answerInput: $('answerInput'), buzzTimer: $('buzzTimer'),
  submitAnswerBtn: $('submitAnswerBtn'), answerFeedback: $('answerFeedback'),
  addToMissedBtn: $('addToMissedBtn'),
  getExplanationBtn: $('getExplanationBtn'), explanationContainer: $('explanationContainer'),
  saveExplanationBtn: $('saveExplanationBtn'),
  sentenceExplanationContainer: $('sentenceExplanationContainer'),
  createFlashcardBtn: $('createFlashcardBtn'), draftFlashcardsContainer: $('draftFlashcardsContainer'),
  saveAllDraftFlashcardsBtn: $('saveAllDraftFlashcardsBtn'),
}

// ------------------------------------------------------------------ state --

// One id per sitting, so a session's answers can be found again later. It is
// generated here and sent up, but nothing is trusted to it: the server files
// every row against the user id from the token, never against anything the
// page says.
const sessionId = crypto.randomUUID()

const DEAD_TIME_SECONDS = 5    // to buzz after the question finishes reading
const ANSWER_TIME_SECONDS = 10 // to answer after buzzing

let words = []          // the tossup, split for the word-by-word read
let wordIndex = 0       // how many words have been shown
let powerIdx = -1       // index of the word holding the (*), or -1
let ticker = null       // the setTimeout chain driving the read
let question = null     // the row currently on screen
// The last AI explanation actually fetched, in raw markdown -- what
// saveExplanationBtn saves. Not the rendered HTML in el.explanationContainer:
// the note is meant to be read again later, in the notebook's own markdown
// renderer, not to carry this page's specific styling.
let explanationText = ''
// One id per tossup, sent as clientAnswerId so the exact same POST /api/answers
// landing twice (a network retry, a second tab, finish()'s own guard failing
// some day) can never write user_stats twice -- see the server-side note in
// routes/answers.py. Only the one real scored submission per tossup ever
// writes a row, so reusing this across a rebuzz's earlier retries (which
// write nothing at all) is correct, not a gap.
let answerAttemptId = null
let buzzed = false
let paused = false
let allowRebuzz = false // practice aid: keep reading after a wrong guess, unscored -- see finish()
let voiceMode = false        // read the tossup aloud instead of word-by-word
let showTossupText = false   // Voice Mode + also print the words as they're spoken
// True while tick() is estimating word position from the timer because this
// platform's speech engine never fires `onboundary` -- the audio is still
// playing, and voice.js's onEnd (not the estimate reaching the end) is what
// closes the tossup out in that case. See voice.js's `onFallback`.
let voiceEstimating = false
let submitting = false  // guards double-submit; see finish()
let reviewMode = false
let filters = []        // the category tree from /api/questions/filters
// Bumped every time the tossup in the reader changes. An AI request captures
// it before going out and drops its own answer if it comes back to a different
// question -- the desktop has had this as `questionGeneration` since the same
// bug bit it there. Without it, asking for an explanation and pressing Next
// before it lands paints the old question's explanation beside the new one,
// with nothing on screen to say it is the wrong one.
let questionGeneration = 0

// Both localStorage keys live up here with the state they guard, not beside
// the functions that read them. `onAuthStateChange` fires during module
// evaluation (Supabase emits INITIAL_SESSION immediately), and everything it
// reaches has to be initialised by then -- a `const` declared further down is
// still in its temporal dead zone at that point and throws. Two real crashes
// have already come from exactly this; see the note above `countdownInterval`.
const PREFS = 'forgeqb.prefs'
// Last known category tree, so the reader's boxes can be filled in on the
// first paint instead of after a round trip. See `loadFilters`.
const FILTERS_CACHE = 'forgeqb.filters.v1'
// The same idea for Adaptive Learning's subject list. See
// `loadAdaptiveCatalogue`.
const ADAPTIVE_CACHE = 'forgeqb.adaptive.v1' 
// Up here for the same temporal-dead-zone reason, and this one was already a
// live latent bug rather than a precaution: the auth handler's signed-out
// branch calls openReader() -> showScreen(), which reads SCREENS, and SCREENS
// used to be declared 28 lines *below* that handler. Every signed-out page
// load therefore threw "Cannot access 'SCREENS' before initialization" and
// abandoned the rest of the handler. It went unnoticed only because
// readerScreen starts visible in index.html, so the screen it failed to show
// was already on screen -- the third instance of this exact mistake in this
// file, after signedInEmail and countdownInterval.
const SCREENS = [
  'readerScreen', 'profileScreen', 'aboutScreen', 'adaptiveSetupScreen',
  'notebookHubScreen', 'notebookDetailScreen', 'recordsScreen', 'reviewListScreen',
]

// "Your Stats" is this sitting, not the account's lifetime total -- matching
// the desktop, whose own `stats` object (renderer.js) is the same kind of
// in-memory counter. It resets on sign-in/app load, and wherever
// `resetSessionStats()` is called: starting Adaptive Learning or starting
// Review Missed. True lifetime totals still exist -- the profile screen reads
// `api.stats()` directly -- this box just isn't them.
//
// Up here rather than beside paintSessionStats for the same reason as SCREENS
// above, and it was the same live bug: the auth handler calls
// resetSessionStats() directly on sign-in, which *assigns* to this, and
// assigning to a `let` still inside its temporal dead zone throws exactly as
// reading one does. The box therefore did not actually zero on sign-in.
let sessionStats = { heard: 0, powers: 0, tens: 0, negs: 0, points: 0, celeritySum: 0, correctCount: 0 }

// Adaptive Learning. `adaptive` is null outside a session and otherwise holds
// the picks, their weights and the running session totals. The skill model
// itself lives in Postgres, not here -- the browser is told the current number
// so it can show it, and is never the thing that remembers it.
let adaptive = null
let adaptiveCatalogue = null

// Declared up here with the rest of the state, not beside the code that uses
// them, and that placement is load-bearing: `onAuthStateChange` below fires
// during module evaluation (Supabase emits INITIAL_SESSION as soon as it is
// registered), and its handler reaches both `updateWhoami` -> signedInEmail
// and `abandonTossup` -> stopCountdown -> countdownInterval. A `let` further
// down the file is still in its temporal dead zone at that moment, so the
// handler threw "Cannot access 'signedInEmail' before initialization" and
// took the rest of the sign-in path with it.
let signedInEmail = ''
let countdownInterval = null

// -------------------------------------------------------------------- auth --

// True only between Supabase firing PASSWORD_RECOVERY (the emailed reset link
// landed back here) and the new password actually being set. The auth-state
// handler checks it so a recovery session -- which is a real, usable session --
// does not just drop the player into the app with their old password still
// live and nothing explaining why they are signed in.
let recoveringPassword = false

// A re-entry lock, not just the disabled buttons. A disabled submit button
// still can't be clicked, but a form submits on Enter too, and the same
// double-request the `submitting` guard stops in finish() is possible here.
let authInFlight = false

/** Lock or unlock the whole sign-in form as one unit. The handlers below all
 *  await a network round trip, and without this the buttons stayed live
 *  through it -- a second click on a slow connection sent a second request,
 *  and nothing on screen said anything was happening. */
function authBusy(busy, message) {
  authInFlight = busy
  for (const b of [el.signInBtn, el.signUpBtn, el.forgotPasswordBtn, el.setNewPasswordBtn]) {
    b.disabled = busy
  }
  if (message !== undefined) el.authMessage.textContent = message
}

const NETWORK_DOWN = 'Could not reach the server. Check your connection and try again.'

el.authForm.addEventListener('submit', async (event) => {
  if (authInFlight) return
  event.preventDefault()
  const mode = event.submitter?.dataset.mode ?? 'signin'
  authBusy(true, mode === 'signup' ? 'Creating your account...' : 'Signing in...')

  const credentials = { email: el.email.value.trim(), password: el.password.value }
  setRememberMe(el.rememberMe.checked)
  try {
    const { error } = mode === 'signup'
      ? await supabase.auth.signUp(credentials)
      : await supabase.auth.signInWithPassword(credentials)

    if (error) {
      // Supabase deliberately does not say whether it was the address or the
      // password that was wrong, and neither should we -- the difference tells
      // a stranger which addresses have accounts.
      authBusy(false, error.message)
      return
    }
    // On sign-in, onAuthStateChange takes over and swaps screens; leave the
    // "Signing in..." message up until it does rather than clearing it here.
    authBusy(false, mode === 'signup'
      ? 'Check your email to confirm the account, then sign in.'
      : el.authMessage.textContent)
  } catch (error) {
    // A network failure rejects rather than returning {error}, so it would
    // otherwise leave the form locked forever.
    authBusy(false, NETWORK_DOWN)
  }
})

el.forgotPasswordBtn.addEventListener('click', async () => {
  if (authInFlight) return
  const email = el.email.value.trim()
  if (!email) {
    el.authMessage.textContent = 'Enter your email address first, then press this again.'
    el.email.focus()
    return
  }
  authBusy(true, 'Sending a reset link...')
  try {
    // redirectTo brings the link back to this same app, where the
    // PASSWORD_RECOVERY branch of onAuthStateChange picks it up.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    // Same reason as a wrong password above: "no account with that email"
    // would confirm which addresses are registered, so the message does not
    // depend on whether one exists.
    authBusy(false, error
      ? error.message
      : 'If an account uses ' + email + ', a reset link is on its way. Open it in this browser.')
  } catch (error) {
    authBusy(false, NETWORK_DOWN)
  }
})

el.recoveryForm.addEventListener('submit', async (event) => {
  if (authInFlight) return
  event.preventDefault()
  const next = el.recoveryPassword.value
  if (next.length < 8) {
    el.authMessage.textContent = 'Password must be at least 8 characters.'
    return
  }
  authBusy(true, 'Setting your new password...')
  try {
    const { error } = await supabase.auth.updateUser({ password: next })
    if (error) {
      authBusy(false, error.message)
      return
    }
    el.recoveryPassword.value = ''
    el.recoveryForm.classList.add('hidden')
    el.recoveryForm.classList.remove('flex')
    el.authForm.classList.remove('hidden')
    authBusy(false, 'Password updated. Signing you in...')
    // The recovery session is already a full session, so the normal signed-in
    // path is exactly right once the password is set.
    const { data: { session } } = await supabase.auth.getSession()
    if (session) enterApp(session)
  } catch (error) {
    authBusy(false, NETWORK_DOWN)
  }
})

el.signOutBtn.addEventListener('click', () => supabase.auth.signOut())

/** The signed-in path, split out so the password-recovery flow can reach it
 *  directly once it has set a password. */
function enterApp(session) {
  recoveringPassword = false
  el.authScreen.classList.add('hidden')
  el.authScreen.classList.remove('flex')
  el.appScreen.classList.remove('hidden')
  signedInEmail = session.user.email
  updateWhoami(signedInEmail)
  loadFilters()
  resetSessionStats()
}

supabase.auth.onAuthStateChange((event, session) => {
  // The reset link just landed. Supabase has created a temporary session, but
  // the player came here to set a password, not to use the app -- so hold on
  // the auth screen and show the recovery form instead of falling through.
  if (event === 'PASSWORD_RECOVERY') {
    recoveringPassword = true
    el.authScreen.classList.remove('hidden')
    el.authScreen.classList.add('flex')
    el.appScreen.classList.add('hidden')
    el.authForm.classList.add('hidden')
    el.recoveryForm.classList.remove('hidden')
    el.recoveryForm.classList.add('flex')
    el.authMessage.textContent = ''
    el.recoveryPassword.focus()
    return
  }
  if (recoveringPassword && session) return   // handled by the recovery form's own submit

  const signedIn = Boolean(session)
  // `hidden` is a class here, not the attribute: the two screens are flex
  // containers, and `display: flex` from a utility class beats the attribute's
  // `display: none`, so a screen hidden by attribute alone stays on screen.
  el.authScreen.classList.toggle('hidden', signedIn)
  el.authScreen.classList.toggle('flex', !signedIn)
  el.appScreen.classList.toggle('hidden', !signedIn)

  if (signedIn) {
    enterApp(session)
  } else {
    abandonTossup()
    openReader()
  }
})

// ---------------------------------------------------------------- screens --

// The desktop is one document with seven hidden pages and no router; this
// keeps that shape rather than adding one. A URL per screen would be better
// on the web and it is a change to make once there are screens worth linking
// to, not while there are two.
const showProfile = initProfile(el)

/** What the empty reader should tell you to press next.
 *
 *  "Click Start Reader" is right only when nothing else is going on. Start
 *  Reader *leaves* both Adaptive Learning and review mode (see its handler),
 *  so telling someone 15 questions into an adaptive session to press it was
 *  pointing them at the one button that silently ends the session they are
 *  still in -- the stats box beside it stays on screen the whole time, so
 *  nothing contradicted the instruction until the session was already gone.
 */
function idlePrompt() {
  if (adaptive) return 'Click “Next Question” to continue your Adaptive Learning session'
  if (reviewMode) return 'Click “Review Next” to continue reviewing'
  return 'Click “Start Reader” to start practicing'
}

/** Show exactly one screen. Leaving a tossup half-read to look at something
 *  else must not leave a timer running behind the page, or score a pass while
 *  nobody is looking at it -- so every departure from the reader abandons the
 *  question in flight. */
function showScreen(name) {
  const leavingReader = name !== 'readerScreen'
    && !el.readerScreen.classList.contains('hidden')
  if (leavingReader) {
    abandonTossup()
    el.questionContainer.textContent = idlePrompt()
  }
  // Settings is a modal, not one of these screens, so it never closed on its
  // own when a nav button switched screens underneath it -- most visibly
  // when an AI feature auto-opened it for a missing key and the next click
  // was Notebook or Records, which left Settings stacked on top of the new
  // screen with no way to tell the two apart.
  closeSettings()
  for (const screen of SCREENS) el[screen].classList.toggle('hidden', screen !== name)
}

function openReader() { showScreen('readerScreen') }

el.profileBtn.addEventListener('click', () => {
  showScreen('profileScreen')
  showProfile()
})

// ---------------------------------------------------- records and review --

// Clicking a record expands its stats inline now -- see records.js -- so
// this no longer needs to hand the profile screen a session to open.
const showRecords = initRecords({ onBack: openReader })

el.recordsBtn.addEventListener('click', () => {
  showScreen('recordsScreen')
  showRecords()
})

const showBrowse = initBrowse(() => filters)
const showReviewList = initReviewList({
  onBack: openReader,
  onStartReviewing: (category) => {
    // The Missed Questions screen has its own category filter, separate
    // from the reader's -- match the reader's picker to it before starting
    // the review, or "Review History" would silently review Any Category.
    const target = category && category !== 'all' ? category : ''
    for (const option of el.categorySelect.options) {
      option.selected = option.value === target
    }
    openReader()
    el.reviewMissedBtn.click()
  },
})

function openReviewListScreen() {
  showScreen('reviewListScreen')
  showReviewList()
  showBrowse()
}


// The header falls back to the email until a username comes back, rather
// than waiting on the request -- a signed-in header that is blank for a
// moment reads as broken. `signedInEmail` itself is declared with the other
// state at the top of the file; see the note there for why.

function updateWhoami(fallbackEmail) {
  el.whoami.textContent = fallbackEmail
  api.username().then(({ username }) => {
    if (username) el.whoami.textContent = username
  }).catch((error) => console.error(error))
}

const loadAccountEmail = initAccountSettings(
  (username) => { el.whoami.textContent = username || signedInEmail })

const openReviewSettings = initReviewSettings({
  onStartReviewing: () => {
    openReader()
    el.reviewMissedBtn.click()
  },
  onOpenReviewList: openReviewListScreen,
})

el.reviewSettingsBtn.addEventListener('click', openReviewSettings)

// ------------------------------------------------------------ reset stats --

function showResetModal(visible) {
  el.resetStatsModal.classList.toggle('hidden', !visible)
  el.resetStatsModal.classList.toggle('flex', visible)
  if (visible) el.resetStatsMessage.textContent = ''
}

el.resetStatsBtn.addEventListener('click', () => showResetModal(true))
el.cancelResetStatsBtn.addEventListener('click', () => showResetModal(false))

el.confirmResetStatsBtn.addEventListener('click', async () => {
  el.confirmResetStatsBtn.disabled = true
  try {
    await api.resetStats()
    showResetModal(false)
    // "Your Stats" is this sitting's own counter, not read from the server --
    // wiping the account's lifetime totals is still a fair moment to zero it
    // too, since a fresh account-wide start is exactly what a new session is.
    resetSessionStats()
    if (!el.profileScreen.classList.contains('hidden')) {
      showProfile()
    }
  } catch (error) {
    el.resetStatsMessage.textContent = error.message
  } finally {
    el.confirmResetStatsBtn.disabled = false
  }
})
el.backToReaderBtn.addEventListener('click', openReader)
el.aboutBtn.addEventListener('click', () => showScreen('aboutScreen'))
el.backFromAboutBtn.addEventListener('click', openReader)

// The notebook owns two of the screens above and swaps between them itself;
// showScreen only has to get us onto the first one.
const notebook = initNotebook({ onBack: openReader })

el.notebookBtn.addEventListener('click', () => {
  showScreen('notebookHubScreen')
  notebook.openHub()
})

// ----------------------------------------------------------------- filters --

/** Selected values of a multi-select, dropping the "Any …" empty option. */
function chosen(select) {
  return [...select.selectedOptions].map((o) => o.value).filter(Boolean)
}

/** Fill the category select from a tree, and put the saved picks back.
 *
 *  The list is rebuilt from scratch each time, which used to mean any category
 *  you had picked reverted to "Any Category" the moment it ran -- so the saved
 *  picks are restored immediately after, same as the reader's other
 *  preferences.
 */
function paintFilters(tree) {
  filters = tree
  el.categorySelect.innerHTML = '<option value="" selected>Any Category</option>'
  for (const category of filters) {
    const option = document.createElement('option')
    option.value = category.category
    option.textContent = `${category.category} (${category.questions.toLocaleString()})`
    el.categorySelect.append(option)
  }
  restoreCategoryPrefs()
}

/** The category tree, painted from the last known copy first and refreshed
 *  from the server behind it.
 *
 *  The tree is a property of the question set, not of the account: it is the
 *  same for everybody and only changes when the question database is replaced.
 *  So there is no reason for the reader's category, subcategory and difficulty
 *  boxes to sit empty for a whole round trip -- Supabase has to settle the
 *  session before `api.filters()` can even be sent, and the request itself
 *  crosses the internet to Postgres. Painting the cached copy first fills them
 *  on the very first frame of every visit after the first; the request still
 *  goes out and repaints if anything actually changed.
 *
 *  Repainting is skipped when the server's answer matches what was already
 *  drawn, because a repaint rebuilds the <select> and would visibly reset a
 *  selection the player had already started making in the meantime.
 */
async function loadFilters() {
  let cached = null
  try { cached = JSON.parse(localStorage.getItem(FILTERS_CACHE)) } catch { cached = null }
  if (Array.isArray(cached) && cached.length) paintFilters(cached)

  try {
    const payload = await api.filters()
    applyYearBounds(payload.years)
    const fresh = payload.categories
    const serialised = JSON.stringify(fresh)
    if (serialised !== JSON.stringify(cached)) {
      paintFilters(fresh)
      // Written after a successful paint, so a shape this build cannot render
      // is never the thing cached for next time.
      try { localStorage.setItem(FILTERS_CACHE, serialised) } catch { /* full or blocked */ }
    }
  } catch (error) {
    // A cached tree already on screen is a working picker, so a failed refresh
    // is not worth surfacing -- the reader itself will report the problem on
    // the next question it tries to fetch.
    console.error(error)
  }
}

/** The full span the question set actually covers, from the API. Until it
 *  arrives the slider stays hidden -- min/max in the HTML are placeholders,
 *  and a slider whose ends are guessed can silently exclude real years. */
let yearBounds = null

/** Fit the two handles inside `bounds`, keeping whatever the player had picked
 *  where it still fits. */
function applyYearBounds(bounds) {
  if (!bounds || bounds.min == null || bounds.max == null || bounds.min === bounds.max) {
    el.yearRangeWrapper.classList.add('hidden')
    yearBounds = null
    return
  }
  yearBounds = bounds
  // `null` is stored deliberately for a handle left at the end of the span
  // (see savePrefs) and means "open" -- it has to be caught before the range
  // check, because Number(null) is 0, which is finite, and would clamp to the
  // wrong end of the span rather than falling back.
  const clamp = (v, fb) => {
    if (v == null) return fb
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(bounds.max, Math.max(bounds.min, n)) : fb
  }
  for (const input of [el.yearMin, el.yearMax]) {
    input.min = bounds.min
    input.max = bounds.max
  }
  // Saved picks first, then the full span.
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(PREFS)) ?? {} } catch { saved = {} }
  el.yearMin.value = clamp(saved.yearMin, bounds.min)
  el.yearMax.value = clamp(saved.yearMax, bounds.max)
  if (Number(el.yearMin.value) > Number(el.yearMax.value)) {
    el.yearMin.value = bounds.min
    el.yearMax.value = bounds.max
  }
  el.yearRangeWrapper.classList.remove('hidden')
  paintYearLabel()
}

/** Keep the two handles from crossing, and update the readout. */
function paintYearLabel() {
  let lo = Number(el.yearMin.value)
  let hi = Number(el.yearMax.value)
  // Whichever handle was just moved is the one that gives -- push the other.
  if (lo > hi) {
    if (document.activeElement === el.yearMin) el.yearMax.value = String(lo), (hi = lo)
    else el.yearMin.value = String(hi), (lo = hi)
  }
  el.yearRangeLabel.textContent =
    lo === hi ? String(lo) : `${lo} – ${hi}`
}

for (const input of [$('yearMin'), $('yearMax')]) {
  input.addEventListener('input', paintYearLabel)
  input.addEventListener('change', savePrefs)
}

/** Puts the saved category/subcategory/difficulty picks back after the
 *  selects are rebuilt -- the multi-selects don't survive being rebuilt
 *  from scratch, they just start from "Any" every time otherwise. */
function restoreCategoryPrefs() {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(PREFS)) ?? {} } catch { saved = {} }

  if (saved.categories?.length) {
    for (const option of el.categorySelect.options) {
      option.selected = saved.categories.includes(option.value)
    }
  }
  refreshSubcategories()
  if (saved.subcategories?.length) {
    for (const option of el.subcategorySelect.options) {
      option.selected = saved.subcategories.includes(option.value)
    }
  }
  if (saved.difficulties?.length) {
    for (const option of el.difficultySelect.options) {
      option.selected = saved.difficulties.includes(option.value)
    }
  }
}

/** Offer subcategories for whatever categories are picked, or hide the box.
 *
 * Hidden rather than shown empty: an empty select that cannot be filled looks
 * broken, and several real categories (Mythology, Geography) have no
 * subcategories at all.
 */
function refreshSubcategories() {
  const picked = chosen(el.categorySelect)
  const available = filters
    .filter((c) => picked.includes(c.category))
    .flatMap((c) => c.subcategories)

  el.subcategorySelect.innerHTML = ''
  for (const sub of available) {
    const option = document.createElement('option')
    option.value = sub.name
    option.textContent = `${sub.name} (${sub.questions.toLocaleString()})`
    el.subcategorySelect.append(option)
  }
  el.subcategoryWrapper.classList.toggle('hidden', available.length === 0)
}

el.categorySelect.addEventListener('change', () => { refreshSubcategories(); savePrefs() })
el.subcategorySelect.addEventListener('change', savePrefs)
el.difficultySelect.addEventListener('change', savePrefs)

/** What the reader should ask for. Subcategory wins over category when set:
 *  picking "American Literature" under "Literature" means the narrower one. */
function questionFilters() {
  const subcategory = chosen(el.subcategorySelect)
  const difficulty = chosen(el.difficultySelect)
  const filters = {
    ...(subcategory.length ? { subcategory } : { category: chosen(el.categorySelect) }),
    ...(difficulty.length ? { difficulty } : {}),
  }
  // Only sent when the handles are inside the full span. At the extremes it is
  // "any year", and the server treats a missing range the same way -- so
  // nothing is gained by sending 2000-2026 except an index decision.
  if (yearBounds) {
    const lo = Number(el.yearMin.value)
    const hi = Number(el.yearMax.value)
    if (lo > yearBounds.min) filters.yearMin = lo
    if (hi < yearBounds.max) filters.yearMax = hi
  }
  return filters
}

// ---------------------------------------------------------------- the read --

/** Milliseconds between words. Copied from the desktop: the slider reads as
 *  speed, the timer wants a delay, so the scale is inverted here. */
function readingDelayMs() {
  return 550 - parseInt(el.readingSpeed.value, 10)
}

/** The same setting as a number that goes *up* as the slider goes right.
 *
 *  The slider is stored as milliseconds-per-word, which runs backwards against
 *  its own "Slower / Faster" ends: dragging toward Faster made the readout
 *  count 500 down to 50, so the control looked inverted even though it was
 *  behaving correctly. Words per minute is the unit a reader actually thinks
 *  in and it rises with the handle. */
function readingWordsPerMinute() {
  return Math.round(60000 / readingDelayMs())
}

function updateSpeedDisplay() {
  if (!voiceMode) {
    el.speedDisplay.textContent = `${readingWordsPerMinute()} words per minute`
    return
  }
  // A speaking utterance's rate is fixed by the Web Speech API -- it can only
  // be set when speech starts. Restarting mid-tossup to apply a change
  // repeats a word and makes the text flicker, so the change lands on the
  // next tossup and the label says so rather than looking broken.
  const pending = voice.isSpeaking()
  el.speedDisplay.textContent =
    `${voice.speechRateFor(el.readingSpeed.value).toFixed(1)}x speaking speed` +
    (pending ? ' — next tossup' : '')
}

el.readingSpeed.addEventListener('input', updateSpeedDisplay)
updateSpeedDisplay()

// The powermark toggle is a class on <body> rather than a change to what the
// reader emits, so it applies to the tossup already on screen instead of only
// to the next one.
el.powerHighlightToggle.addEventListener('change', () => {
  document.body.classList.toggle('no-power', !el.powerHighlightToggle.checked)
})

// ------------------------------------------------------------- voice mode --

if (!voice.voiceSupported()) {
  el.voiceModeToggle.disabled = true
  el.voiceUnsupported.classList.remove('hidden')
}

el.voiceModeToggle.addEventListener('change', () => {
  voiceMode = el.voiceModeToggle.checked
  // Both classes, matching the modal show/hide idiom elsewhere: the row is a
  // <label>, which is display:inline by default, so removing `hidden` alone
  // left `items-center`/`gap-2` inert and the checkbox unaligned.
  el.showTextRow.classList.toggle('hidden', !voiceMode)
  el.showTextRow.classList.toggle('flex', voiceMode)
  updateSpeedDisplay()

  const inProgress = words.length > 0 && !buzzed && wordIndex < words.length
  if (!inProgress) {
    // Nothing running to carry across. Still say what's true if the reader
    // is sitting empty; leave a fully-read or already-buzzed tossup alone.
    if (!words.length) {
      el.questionContainer.textContent = voiceMode
        ? 'Voice Mode on — press “Next Question” to hear a tossup.'
        : idlePrompt()
    }
    return
  }

  // A tossup is actively running -- keep it going in the new mode from
  // wherever it had gotten to, instead of abandoning it outright. The same
  // "stop whichever mechanism was running, start the other one at the
  // current word" switch the Resume button already makes.
  stopTicker()
  voice.stopSpeaking()
  if (paused) return // stays paused; Resume picks the right mode up from here

  if (voiceMode && voice.voiceSupported()) {
    if (!showTossupText) el.questionContainer.textContent = '🔊 Listening…'
    speakCurrentTossup(wordIndex)
  } else {
    paintWords(wordIndex)
    tick()
  }
})

el.showTextToggle.addEventListener('change', () => {
  showTossupText = el.showTextToggle.checked
  // Reflect the change straight away rather than waiting for the next tossup.
  if (voiceMode && words.length) {
    if (showTossupText) paintWords(Math.min(wordIndex + 1, words.length))
    else el.questionContainer.textContent = '🔊 Listening…'
  }
})

// Speech keeps running after the tab closes on some platforms.
window.addEventListener('beforeunload', () => voice.stopSpeaking())

/** One word, marked up if it falls inside the power.
 *
 * Shared by every path that paints question text, so the highlight cannot be
 * applied while reading and then lost on the end-of-tossup reveal -- which is
 * exactly what used to happen on the desktop: both reveal paths assigned the
 * raw question text, so the marking vanished at the moment you would most want
 * it, looking back at what you just answered.
 */
function wordHtml(i) {
  const word = escapeHtml(words[i])
  if (powerIdx === -1 || i > powerIdx) return word
  // The (*) is a marker rather than part of the sentence, so it is styled
  // apart from the words around it instead of being bolded along with them.
  const marked = word.replace(/\(\*\)/g, '<span class="power-mark">(*)</span>')
  return `<strong class="power-text">${marked}</strong>`
}

/** Question text is data, and it goes into innerHTML for the power markup, so
 *  it is escaped first. The set is packet text rather than user input, but the
 *  rule is about where a string is going, not where it came from. */
function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function paintWords(upto) {
  let html = ''
  for (let i = 0; i < upto && i < words.length; i++) html += wordHtml(i) + ' '
  el.questionContainer.innerHTML = html
}

function stopTicker() {
  clearTimeout(ticker)
  ticker = null
}

// Read all the way out with nobody buzzing -- shared by the plain reveal and
// Voice Mode, since a tossup counts as heard the same way either way. Five
// seconds of dead time before the tossup closes; ending the instant the last
// word lands would score a pass on a question the reader is still finishing
// saying.
function onTossupFullyRead() {
  if (!buzzed && !countdownInterval) {
    startCountdown(DEAD_TIME_SECONDS, 'Buzz in', () => finish({ didBuzz: false, guess: '' }))
  }
}

function tick() {
  if (buzzed || paused) return
  if (wordIndex >= words.length) {
    // While the timer is only estimating position for still-playing speech
    // (voice.js couldn't get onboundary events on this platform), voice.js's
    // own onEnd closes the tossup out instead -- reaching the end of the
    // estimate does not mean the voice has actually finished.
    if (voiceEstimating) return
    onTossupFullyRead()
    return
  }
  // In Voice Mode the words are being spoken, so only paint them here if the
  // user also asked to see the text -- this is also the fallback ticker
  // while voice.js estimates position, and that path must stay silent unless
  // showTossupText says otherwise.
  if (!voiceMode || showTossupText) {
    // Appended one word at a time rather than repainting the whole container
    // on every tick, which is why this does not just call paintWords().
    el.questionContainer.insertAdjacentHTML('beforeend', wordHtml(wordIndex) + ' ')
  }
  wordIndex++
  ticker = setTimeout(tick, readingDelayMs())
}

/** Read the tossup aloud from `startIndex`, falling back to the plain ticker
 *  if speech isn't supported or dies mid-question. */
function speakCurrentTossup(startIndex = 0) {
  if (!voice.voiceSupported()) { tick(); return }
  voiceEstimating = false

  voice.speak(words, startIndex, voice.speechRateFor(el.readingSpeed.value), {
    onWord: (idx) => {
      // A late-but-real boundary event can land after onFallback already
      // started the ticker below (the engine was merely slow to fire its
      // first one, not actually unsupported) -- without this, both the
      // ticker's setTimeout chain and this callback would go on writing
      // wordIndex independently, racing each other and corrupting the buzz
      // position celerity is computed from. Only one driver of wordIndex may
      // ever run at a time.
      stopTicker()
      wordIndex = idx
      voiceEstimating = false
      // `onboundary` fires as a word *starts*; wordIndex counts words already
      // finished, so revealing only up to wordIndex would leave the text one
      // word behind the voice. Include the word currently being spoken.
      if (showTossupText) paintWords(Math.min(wordIndex + 1, words.length))
    },
    onEnd: () => {
      wordIndex = words.length
      if (showTossupText) paintWords(words.length)
      onTossupFullyRead()
    },
    onError: () => tick(),      // speech died -- still playable, just silent
    onFallback: () => {
      // No boundary events on this platform. Audio keeps playing; the ticker
      // estimates position so celerity stays meaningful, but onEnd above is
      // still what closes the tossup out.
      voiceEstimating = true
      tick()
    },
  })
}

// ---------------------------------------------------------------- countdown --

// `countdownInterval` itself is declared with the other state at the top of
// the file rather than here; see the note there for why.

function stopCountdown() {
  clearInterval(countdownInterval)
  countdownInterval = null
  el.buzzTimer.classList.add('hidden')
}

/** Show a ticking countdown; call onExpire() when it hits zero.
 *
 * The deadline is wall-clock rather than a tick count, so a tab that was
 * backgrounded (where timers are throttled) comes back with the right answer
 * instead of with however many ticks the browser felt like running.
 */
function startCountdown(seconds, label, onExpire) {
  stopCountdown()
  const endsAt = Date.now() + seconds * 1000

  const render = () => {
    const left = Math.max(0, endsAt - Date.now())
    el.buzzTimer.textContent = `${label} ${(left / 1000).toFixed(1)}s`
    el.buzzTimer.classList.toggle('text-red-500', left <= 3000)
    el.buzzTimer.classList.toggle('text-text-muted', left > 3000)
    if (left <= 0) {
      stopCountdown()
      onExpire()
    }
  }

  el.buzzTimer.classList.remove('hidden')
  render()
  countdownInterval = setInterval(render, 100)
}

// ------------------------------------------------------------ load a tossup --

/** Reset everything a live tossup owns. */
function abandonTossup() {
  stopTicker()
  stopCountdown()
  voice.stopSpeaking()
  voiceEstimating = false
  words = []
  wordIndex = 0
  powerIdx = -1
  question = null
  questionGeneration++
  answerAttemptId = crypto.randomUUID()
  buzzed = false
  paused = false
  submitting = false
  el.pauseBtn.textContent = 'Pause'
  el.answerInput.disabled = true
  el.answerInput.value = ''
  el.answerInput.placeholder = 'Buzz to answer'
  el.submitAnswerBtn.dataset.state = 'buzz'
  el.submitAnswerBtn.textContent = 'Buzz'
  el.submitAnswerBtn.disabled = true
  el.answerFeedback.classList.add('hidden')
  el.addToMissedBtn.classList.add('hidden')
  el.addToMissedBtn.disabled = false
  el.questionMeta.textContent = ''
  el.reviewAheadNotice.classList.add('hidden')
  el.getExplanationBtn.disabled = true
  el.getExplanationBtn.classList.remove('hidden')
  el.explanationContainer.textContent =
    'Click "Get Explanation" to see an AI-generated explanation of the question.'
  // Nothing to save until a fresh explanation is fetched for whichever
  // question comes next -- and the last one's text belongs to a question
  // that's gone, same reason questionGeneration exists.
  explanationText = ''
  el.saveExplanationBtn.classList.add('hidden')
  el.saveExplanationBtn.disabled = false
  el.saveExplanationBtn.textContent = 'Save Note'
  // The per-clue panel is emptied as well as hidden. Left filled it would
  // flash the previous tossup's clue explanation for as long as it takes the
  // next one to be asked about, which is the same stale-content bug the
  // generation counter guards against in flight.
  el.sentenceExplanationContainer.classList.add('hidden')
  el.sentenceExplanationContainer.textContent = ''
  el.createFlashcardBtn.disabled = true
  el.draftFlashcardsContainer.textContent =
    'Click "Create Flashcard" to draft flashcards from this tossup.'
  el.saveAllDraftFlashcardsBtn.classList.add('hidden')
}

async function loadQuestion(fetcher) {
  abandonTossup()
  // abandonTossup() bumped questionGeneration; anything that resolves against a
  // different value has been superseded. Spamming Next Question -- or the `n`
  // shortcut -- used to fire several of these at once: each response set
  // `words`/`wordIndex` and started its own `tick()` loop, so two revealers
  // ran together at double speed over whichever question landed last, and the
  // buzz/celerity maths was reading a `words` array from a different tossup
  // than the one on screen.
  const gen = questionGeneration
  el.questionContainer.textContent = 'Loading…'

  let loaded
  try {
    loaded = await fetcher()
  } catch (error) {
    if (gen !== questionGeneration) return
    el.questionContainer.textContent = error instanceof ApiError && error.empty
      ? error.message
      : 'Could not load a question.'
    if (error instanceof ApiError && error.empty && reviewMode) leaveReview()
    return
  }
  if (gen !== questionGeneration) return   // a newer loadQuestion is now in charge
  question = loaded

  // The queue isn't empty, but nothing in it is actually due yet -- the
  // server still offers the soonest-scheduled one so a player who wants to
  // get ahead can, but Review Missed serving *any* question the moment
  // there's nothing due read as "it reviews even when there's nothing to
  // review." Leaving review mode here instead of showing that question
  // means clicking Review Missed only ever serves something that's actually
  // due.
  if (reviewMode && question.is_due === false) {
    question = null
    el.questionContainer.textContent = 'Nothing is due for review right now — check back later.'
    leaveReview()
    return
  }

  words = String(question.question).split(/\s+/).filter(Boolean)
  // 41% of the set has no powermark, and the mark can be fused to punctuation
  // ("beta,(*)"), so this looks for it inside a word rather than as a word --
  // the same rule the server scores by (routes/answers.py:_power_index).
  powerIdx = words.findIndex((w) => w.includes('(*)'))
  wordIndex = 0

  el.questionMeta.textContent = [
    question.category, question.subcategory,
    question.difficulty != null ? `difficulty ${question.difficulty}` : null,
    question.set_name,
  ].filter(Boolean).join(' · ')

  // An adaptive question carries the state the server used to pick it. The
  // restore key in particular has to come back on the answer, so the skill
  // update lands on the same selection this session is playing.
  if (adaptive && question.adaptive) {
    adaptive.restoreKey = question.adaptive.restoreKey
    adaptive.subject = question.adaptive.subcategory
    adaptive.skill = question.adaptive.skill
    // Only the first question's skill counts as this sitting's starting
    // point -- every question after this one updates adaptive.skill above,
    // and Save & Quit needs the value from before any of that happened.
    // category_user_state's own start_difficulty can't stand in for this: it
    // is deliberately frozen at whatever it was the very first time this
    // category was ever played, not this sitting's start (see
    // routes/adaptive.py's /end).
    if (adaptive.startSkill === null) adaptive.startSkill = question.adaptive.skill
    paintAdaptiveStats()

    // Said once, on the first question, when there was already a model to pick
    // up. Silence here would make a resumed session look like a fresh one.
    if (question.adaptive.resumed && adaptive.answered === 0) {
      el.adaptiveResumed.textContent =
        `Picking up where you left off — ${question.adaptive.questionsServed - 1} ` +
        'questions already seen in this subject.'
      el.adaptiveResumed.classList.remove('hidden')
    }
  }


  el.submitAnswerBtn.disabled = false
  // getExplanationBtn is deliberately NOT re-enabled here -- see the comment
  // where it's turned back on, in finish(). A fresh tossup starts with it
  // disabled and stays that way until this one is actually over.
  el.createFlashcardBtn.disabled = false
  el.questionContainer.innerHTML = ''

  // Voice Mode speaks the tossup; normal mode reveals it word by word.
  if (voiceMode && voice.voiceSupported()) {
    if (!showTossupText) el.questionContainer.textContent = '🔊 Listening…'
    speakCurrentTossup()
  } else {
    tick()
  }
}

el.getNewQuestionBtn.addEventListener('click', () => {
  // Start Reader is how you get back to ordinary play, so it leaves both of the
  // modes rather than only review.
  if (reviewMode) leaveReview()
  if (adaptive) leaveAdaptive()
  loadQuestion(() => api.randomQuestion(questionFilters()))
})

el.getManyQuestionsBtn.addEventListener('click', () => {
  // Skipping mid-read records nothing. A question you walked away from was not
  // heard, and counting it would quietly inflate every rate on the profile.
  if (adaptive) nextAdaptiveQuestion()
  else if (reviewMode) loadQuestion(() => api.nextReview(chosen(el.categorySelect)))
  else loadQuestion(() => api.randomQuestion(questionFilters()))
})

el.reviewMissedBtn.addEventListener('click', () => {
  if (adaptive) leaveAdaptive()
  // This same button also serves "next review question" on every click after
  // the first (see its "Review Next" label below) -- only the transition into
  // review mode is a new sitting worth zeroing the stats box for.
  if (!reviewMode) resetSessionStats()
  reviewMode = true
  el.stopReviewBtn.classList.remove('hidden')
  el.reviewMissedBtn.textContent = 'Review Next'
  loadQuestion(() => api.nextReview(chosen(el.categorySelect)))
})

el.stopReviewBtn.addEventListener('click', () => {
  leaveReview()
  // Leaving review does NOT start a fresh question. Stopping something should
  // stop it, not swap it for a random tossup you did not ask for.
  abandonTossup()
  el.questionContainer.textContent = 'Click “Start Reader” to start practicing'
})

function leaveReview() {
  reviewMode = false
  el.stopReviewBtn.classList.add('hidden')
  el.reviewMissedBtn.textContent = 'Review Missed'
}

el.pauseBtn.addEventListener('click', () => {
  if (!words.length || buzzed) return
  paused = !paused
  el.pauseBtn.textContent = paused ? 'Resume' : 'Pause'
  const speaking = voiceMode && voice.isSpeaking()
  if (paused) {
    stopTicker()
    if (speaking) voice.pauseSpeaking()
  } else if (speaking) {
    voice.resumeSpeaking()
  } else if (voiceMode && voice.voiceSupported()) {
    // Not every pause leaves an utterance to resume: `onend`/`onerror` can
    // land between the pause click and this one and null it out first, and
    // `speech.resume()` has nothing left to act on then. Restart the
    // utterance at the current word instead of falling through to the plain
    // ticker, which would start the *text* ticker with no audio behind it.
    speakCurrentTossup(wordIndex)
  } else {
    tick()
  }
})

// -------------------------------------------------------------------- buzz --

function buzz() {
  if (buzzed || !words.length || wordIndex === 0 || submitting) return
  buzzed = true
  stopTicker()
  stopCountdown()
  // Cut the audio immediately -- hearing another word after buzzing would be
  // wrong both for the feel of it and for the celerity already recorded.
  voice.stopSpeaking()
  el.answerInput.disabled = false
  el.answerInput.placeholder = 'Your answer'
  el.answerInput.focus()
  el.submitAnswerBtn.dataset.state = 'submit'
  el.submitAnswerBtn.textContent = 'Submit'
  startCountdown(ANSWER_TIME_SECONDS, 'Answer in', () => {
    // Out of time. Submitting blank is allowed and scores a neg, which is what
    // a real timeout costs.
    finish({ didBuzz: true, guess: el.answerInput.value })
  })
}

el.submitAnswerBtn.addEventListener('click', () => {
  if (el.submitAnswerBtn.dataset.state === 'buzz') buzz()
  else finish({ didBuzz: true, guess: el.answerInput.value })
})

el.answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') finish({ didBuzz: true, guess: el.answerInput.value })
})

// The three modals that float *over* the reader rather than replacing it.
// (The notebook's own two live on the notebook screen, which hides the reader
// outright, so the screen test below already covers them.)
const READER_MODALS = ['settingsModal', 'reviewSettingsModal', 'resetStatsModal']

/** Is anything covering the reader right now? */
function modalOpen() {
  return READER_MODALS.some((id) => !$(id).classList.contains('hidden'))
}

/** Close whatever is covering the reader. Returns true if it closed something. */
function closeTopModal() {
  let closed = false
  for (const id of READER_MODALS) {
    const modal = $(id)
    if (modal.classList.contains('hidden')) continue
    modal.classList.add('hidden')
    modal.classList.remove('flex')
    closed = true
  }
  return closed
}

document.addEventListener('keydown', (event) => {
  // Escape closes whatever is on top. The notebook already did this for its
  // own two modals; these three had no key at all, so Escape worked on two
  // dialogs out of five and the difference looked arbitrary from the outside.
  // Handled before the `typing` test on purpose -- Escape is exactly the key
  // you reach for *while* your cursor is in one of these fields.
  if (event.key === 'Escape' && closeTopModal()) return

  // A range slider is an <input> you cannot type into, so testing the tag name
  // alone would kill every shortcut after touching one. Only real text entry
  // swallows keys.
  const typing = event.target.matches('input:not([type=range]), textarea, select')
  if (typing) return
  if (el.appScreen.classList.contains('hidden')) return

  // "?" is the exception to every rule below: it is how you find out the rest
  // exist, so it works with shortcuts switched off and on any screen.
  if (event.key === '?') {
    el.settingsBtn.click()
    return
  }
  if (!el.shortcutsToggle.checked) return
  // The reader's shortcuts belong to the reader. Pressing S on the profile
  // page would start a tossup on a screen that cannot show it.
  if (el.readerScreen.classList.contains('hidden')) return
  // ...and they do not belong to a dialog sitting on top of it. These modals
  // cover the reader without hiding it, so with Settings open, N advanced the
  // tossup underneath and Space buzzed on a question nobody could see -- both
  // scored, both invisible until the dialog was dismissed.
  if (modalOpen()) return

  const key = event.key.toLowerCase()
  if ((event.code === 'Space' || key === 'b') && !buzzed && words.length) {
    event.preventDefault()
    buzz()
  } else if (key === 's') {
    el.getNewQuestionBtn.click()
    toast('Start Reader')
  } else if (key === 'n') {
    el.getManyQuestionsBtn.click()
    toast('Next question')
  } else if (key === 'a') {
    el.adaptiveLearningBtn.click()
  } else if (key === 'p') {
    el.pauseBtn.click()
    toast(paused ? 'Paused' : 'Resumed')
  } else if (key === 'e' && !el.getExplanationBtn.disabled) {
    el.getExplanationBtn.click()
  }
})

// ------------------------------------------------------------------ submit --

async function finish({ didBuzz, guess }) {
  // Locked *before* the request, not after. The round trip can take seconds,
  // and Enter, the button and the timeout path all reach this function -- so
  // disabling the button after awaiting leaves a window where the answer can
  // be scored twice. On the desktop build that window wrote two user_stats
  // rows, two review attempts and -10 points for one neg.
  if (submitting || !question) return
  submitting = true
  stopTicker()
  stopCountdown()
  voice.stopSpeaking()
  el.submitAnswerBtn.disabled = true
  el.answerInput.disabled = true

  // Show what we already know, now, instead of freezing until the server
  // answers. The round trip is roughly a second (an answer check against
  // qbreader is ~350ms of it, plus two database round trips), and the reader
  // used to spend all of it as a half-revealed question and a dead button with
  // nothing to say it was working -- which reads as the app having hung, not
  // as the app being busy.
  //
  // Every word is already in `words`; the only thing genuinely worth waiting
  // for is the verdict and the answerline. So the rest of the tossup goes up
  // immediately and the feedback box says what is happening.
  //
  // **Except when a rebuzz is still possible**, where the tossup is not over
  // and revealing it would hand over the clues the player is meant to still be
  // listening for. That is the same condition the server scores by (see
  // routes/answers.py: a retry needs `0 < words_read < total_words`), so the
  // two agree about when the question has actually ended.
  const retryPossible = allowRebuzz && didBuzz && wordIndex > 0 && wordIndex < words.length
  if (!retryPossible) paintWords(words.length)
  showFeedback('Checking your answer…', true)

  try {
    const result = await api.submitAnswer({
      questionId: question.id,
      // An adaptive sitting is its own session -- see the note where it is
      // created. Ordinary play keeps the page-wide id.
      sessionId: adaptive?.sessionId ?? sessionId,
      guess,
      buzzed: didBuzz,
      wordsRead: wordIndex,
      rebuzzable: allowRebuzz,
      clientAnswerId: answerAttemptId,
      // Only the restore key travels. Which cluster's skill moves is decided
      // server-side from the question row -- see _apply_to_skill_model.
      ...(adaptive?.restoreKey ? { adaptive: { restoreKey: adaptive.restoreKey } } : {}),
    })

    if (result.retry) {
      // Wrong, but words remain and rebuzzes are on -- the server recorded
      // nothing (see routes/answers.py), so this tossup just keeps reading.
      buzzed = false
      el.submitAnswerBtn.dataset.state = 'buzz'
      el.submitAnswerBtn.textContent = 'Buzz'
      el.submitAnswerBtn.disabled = false
      el.answerInput.value = ''
      el.answerInput.disabled = true
      el.answerInput.placeholder = 'Buzz to answer'
      showFeedback('Not it — keep listening.', false)
      if (voiceMode && voice.voiceSupported()) speakCurrentTossup(wordIndex)
      else tick()
      return
    }

    showResult(result)
    recordSessionAnswer(result)
    // Not enabled when the question first loads any more -- an explanation
    // necessarily names the answer (see geminiGetter.py's "explain" prompt),
    // and unlocking it before the tossup is actually over meant it could be
    // clicked mid-read, spoiling a question the player hadn't attempted yet.
    // This is the one place a buzz-and-retry can't reach without landing
    // here for real: a rebuzz returns above at `result.retry` and never gets
    // this far, and a tossup nobody buzzed still reaches this same line
    // through onTossupFullyRead's own call into finish().
    el.getExplanationBtn.disabled = false

    if (adaptive && result.adaptive?.graded) {
      adaptive.answered += 1
      if (result.correct) adaptive.correct += 1
      adaptive.skill = result.adaptive.skill
      paintAdaptiveStats()
    }
  } catch (error) {
    // The request failed -- a dropped connection, a 500, qbreader timing out.
    // Nothing was scored, so this has to be retryable: hand the Submit button
    // and the answer box back with what was typed still in place, rather than
    // leaving a dead question that can only be abandoned with Next. This is
    // the same dead-end that bit Add to Missed and the notebook deletes, on
    // the one path where it matters most.
    showFeedback(`${escapeHtml(error.message)} — press Submit to try again.`, false)
    if (buzzed && question) {
      el.submitAnswerBtn.disabled = false
      el.answerInput.disabled = false
      el.answerInput.focus()
    }
  } finally {
    // Released in a finally: a backend that disappears mid-answer would
    // otherwise leave this stuck and silently ignore every later submit.
    submitting = false
  }
}

function showFeedback(html, good) {
  el.answerFeedback.className =
    `mt-4 rounded-lg p-3 text-sm ${good ? 'bg-emerald-900/50 text-emerald-200'
                                        : 'bg-red-900/50 text-red-200'}`
  el.answerFeedback.innerHTML = html
}

// ------------------------------------------------- per-sentence explanations --

// Split on sentence endings, but NOT after an initial ("O. Henry") or a common
// abbreviation, and only where a new sentence actually begins. Copied verbatim
// from the desktop (renderer.js), including the reasoning, because it was
// arrived at by measurement rather than by reading: a naive /(?<=[.?!])\s+/
// turned "by O. Henry." into a bogus "Henry." sentence and scattered stray
// icons through names. The lookbehind also allows a CLOSING quote after the
// terminal punctuation -- quizbowl puts the period inside a quoted title
// (`... wrote "The Overcoat." A later work ...`), so the character before the
// space is a quote, not a period. Without that allowance two sentences merged
// into one icon on 29.9% of the question bank; measured over 3,000 tossups,
// 857 gained a boundary and none lost one.
const SENTENCE_BOUNDARY =
  /(?<!\b[A-Z]\.)(?<!\bMr\.)(?<!\bMrs\.)(?<!\bMs\.)(?<!\bDr\.)(?<!\bSt\.)(?<!\bJr\.)(?<!\bSr\.)(?<!\bvs\.)(?<=[.?!]["'”’]?)\s+(?=["'“‘(]?[A-Z])/g

// Only the newest sentence request may paint. `api.js` has no way to pass an
// AbortController through, so a superseded reply is dropped on arrival rather
// than cancelled in flight -- the visible behaviour is the same one the
// desktop gets from aborting, which is that a slow answer for a clue you have
// moved past never renders over the one you are looking at.
let sentenceRequest = 0

/** Put a ❓ after every finished sentence in the revealed tossup.
 *
 *  Called only once a tossup has fully read out (see showResult), never on the
 *  per-word tick -- the desktop does the same, and it matters: icons on text
 *  that has not been read yet would let a player probe ahead of the reader.
 *  Idempotent, because the container is repainted by paintWords and this can
 *  legitimately be reached twice for one question.
 */
function addSentenceExplanationIcons(container) {
  if (container.querySelector('.explanation-icon')) return

  // Text sitting directly in the container, not inside a span. paintWords
  // wraps the powermark in its own <span>, and skipping those leaves the
  // marker alone instead of splitting a sentence around it.
  const textNodes = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.parentElement.tagName.toLowerCase() !== 'span') textNodes.push(node)
  }

  for (const node of textNodes) {
    const sentences = node.nodeValue.split(SENTENCE_BOUNDARY)
    if (!sentences.some((sentence) => sentence.trim().length)) continue

    const fragment = document.createDocumentFragment()
    for (const sentence of sentences) {
      if (!sentence.trim().length) continue
      const span = document.createElement('span')
      span.textContent = sentence
      fragment.append(span)

      // The same closing-quote allowance as SENTENCE_BOUNDARY above. If the
      // two disagree, the splitter produces a segment ending `..."` that this
      // gate then refuses to mark, leaving a clue on screen with no way to
      // ask about it.
      if (/[.?!]["'”’]?$/.test(sentence.trim())) {
        const icon = document.createElement('span')
        icon.className = 'explanation-icon text-blue-400'
        icon.textContent = ' ❓'
        icon.title = 'Explain this clue'
        icon.addEventListener('click', (event) => {
          event.stopPropagation()
          explainSentence(sentence.trim(), icon)
        })
        fragment.append(icon)
      }
      fragment.append(document.createTextNode(' '))   // whitespace the split ate
    }
    node.parentNode.replaceChild(fragment, node)
  }
}

async function explainSentence(sentence, icon) {
  if (!question) return
  const label = icon.textContent
  const askedFor = questionGeneration
  const ticket = ++sentenceRequest
  icon.textContent = ' …'

  el.sentenceExplanationContainer.classList.remove('hidden')
  el.sentenceExplanationContainer.textContent = 'Asking the AI…'

  try {
    const { explanation } = await api.explainSentence(question.id, sentence)
    if (ticket !== sentenceRequest || askedFor !== questionGeneration) return
    el.sentenceExplanationContainer.innerHTML =
      `<strong>Explanation:</strong> ${escapeHtml(explanation || 'The AI returned nothing for that clue.')}`
  } catch (error) {
    if (ticket !== sentenceRequest || askedFor !== questionGeneration) return
    // `no_key` used to open Settings and focus the key box. The website has
    // no key box any more -- AI runs on the operator's key (see
    // web/api/ai.py) -- so the message, which now says the feature is off,
    // is all there is to show.
    el.sentenceExplanationContainer.textContent = error.message
  } finally {
    // Restored even on a superseded request: the icon belongs to the tossup on
    // screen, and leaving it as an ellipsis would make a clue look permanently
    // mid-request.
    icon.textContent = label
  }
}

function showResult(result) {
  const verdict = { power: 'Power!', ten: 'Correct', neg: 'Neg', pass: 'No buzz' }[result.outcome]
  const sign = result.points > 0 ? '+' : ''
  showFeedback(
    `<strong>${verdict} (${sign}${result.points})</strong> — ANSWER: ` +
    `${escapeHtml(result.answer)}` +
    (result.scoredOffline ? ' · scored offline' : ''),
    Boolean(result.correct))

  // The whole tossup, with the power still marked -- this is the moment the
  // marking is most worth having, and the desktop used to lose it right here.
  paintWords(words.length)
  // ...and only now, with the question over, does each sentence get its ❓.
  addSentenceExplanationIcons(el.questionContainer)

  // The label follows the outcome. "Add to missed" on a question you just got
  // right reads as the wrong control, and the endpoint is the same either way.
  el.addToMissedBtn.classList.toggle('hidden', reviewMode)
  el.addToMissedBtn.textContent = result.correct ? 'Review this again' : 'Add to Missed'
}

el.addToMissedBtn.addEventListener('click', async () => {
  if (!question) return
  const label = el.addToMissedBtn.textContent
  el.addToMissedBtn.disabled = true
  try {
    await api.addToReview(question.id)
    el.addToMissedBtn.textContent = 'Added'
    toast('Added to your review list')
  } catch (error) {
    // The button is handed back rather than left disabled holding the error
    // as its own label. That mattered a little when a neg filed the question
    // automatically and this was a shortcut; it matters properly now that
    // this is the *only* way into the review list, because a click that
    // failed once and cannot be retried is a question quietly lost. The
    // message goes to the toast -- it is a sentence, and this is a button.
    el.addToMissedBtn.disabled = false
    el.addToMissedBtn.textContent = label
    toast(error.message)
  }
})

// -------------------------------------------------------------- AI explain --

el.getExplanationBtn.addEventListener('click', async () => {
  if (!question) return
  const asked = questionGeneration
  el.getExplanationBtn.disabled = true
  el.explanationContainer.textContent = 'Asking the AI…'
  try {
    // The question and answer are read off the id on the server -- see
    // routes/ai.py -- so only the id and whatever was typed as a guess go up.
    const { explanation } = await api.explainQuestion(question.id, el.answerInput.value)
    // Gemini takes seconds; Next Question takes one click. If the tossup moved
    // on while this was in flight, the answer belongs to a question that is no
    // longer on screen -- drop it rather than painting it under the new one.
    if (asked !== questionGeneration) return
    el.explanationContainer.innerHTML = renderMarkdown(explanation)
    explanationText = explanation
    el.saveExplanationBtn.classList.remove('hidden')
  } catch (error) {
    if (asked !== questionGeneration) return
    el.explanationContainer.textContent = error.message
    el.getExplanationBtn.disabled = false
  }
})

el.saveExplanationBtn.addEventListener('click', async () => {
  if (!explanationText || !question) return

  el.saveExplanationBtn.disabled = true
  el.saveExplanationBtn.textContent = 'Saving…'
  try {
    // category and answerText are both left out, same as Save Highlight's
    // api.saveClue call just above -- the reader is never told the answer to
    // a tossup it hasn't scored yet (see the module note by
    // getExplanationBtn's markup), so there is nothing honest to send. The
    // server resolves both off sourceQuestionId itself; see
    // routes/notebook.py's save_note.
    await api.saveNote({ content: explanationText, sourceQuestionId: question.id })
    toast('Explanation saved to your notebook')
    // Matches the desktop's own Save Note: there is nothing left to fetch for
    // this tossup once its explanation is in the notebook, so both buttons
    // go rather than leaving a live Get Explanation that would just offer
    // the identical text a second time.
    el.saveExplanationBtn.textContent = 'Saved!'
    el.getExplanationBtn.classList.add('hidden')
    notebook.resetShelfCache()
  } catch (error) {
    el.saveExplanationBtn.disabled = false
    el.saveExplanationBtn.textContent = 'Save Note'
    toast(error.message)
  }
})

// ---------------------------------------------------------------- flashcards --

function paintDraftCards(cards, category, sourceQuestionId) {
  if (!cards.length) {
    el.draftFlashcardsContainer.textContent = 'No usable cards came back. Try again.'
    el.saveAllDraftFlashcardsBtn.classList.add('hidden')
    return
  }
  // Each card gets its own Save -- a draft is not all-or-nothing, and the
  // same "half a card is not a card" rule the notebook applies server-side
  // means a player should be able to keep the three good ones and discard a
  // fourth that came back garbled, rather than losing all four to one bad card.
  // "Save All" (below) is additive on top of that, not a replacement for it.
  el.draftFlashcardsContainer.innerHTML = cards.map((c, i) => `
    <div data-draft-card="${i}" class="relative rounded-lg bg-secondary-dark p-3">
      <button data-delete-draft="${i}" title="Discard this card" class="absolute right-2 top-2 rounded-full bg-red-700 px-3 py-1 text-xs font-bold text-white hover:bg-red-800">Delete</button>
      <p class="pr-16 font-bold">${escapeHtml(c.term)}</p>
      <p class="mt-1 text-text-muted">${escapeHtml(c.definition)}</p>
      <button data-save-draft="${i}" class="mt-2 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white hover:bg-green-700">Save</button>
    </div>`).join('')

  // Discarded cards drop out of both "still visible" (removed from the DOM)
  // and "eligible for Save All" (removed here too) -- a deleted draft must
  // not come back to life the next time the bulk button runs.
  const savedFlags = cards.map(() => false)
  const discarded = cards.map(() => false)

  function updateSaveAllVisibility() {
    const anyPending = cards.some((_, i) => !savedFlags[i] && !discarded[i])
    el.saveAllDraftFlashcardsBtn.classList.toggle('hidden', !anyPending)
    el.saveAllDraftFlashcardsBtn.disabled = false
    el.saveAllDraftFlashcardsBtn.textContent = 'Save All'
  }

  el.draftFlashcardsContainer.querySelectorAll('[data-save-draft]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.saveDraft)
      const card = cards[index]
      btn.disabled = true
      btn.textContent = 'Saving…'
      try {
        await api.saveFlashcards({
          category, sourceQuestionId,
          flashcards: [{ term: card.term, definition: card.definition }],
        })
        btn.textContent = 'Saved'
        savedFlags[index] = true
        updateSaveAllVisibility()
      } catch (error) {
        btn.textContent = error.message
        btn.disabled = false
      }
    })
  })

  el.draftFlashcardsContainer.querySelectorAll('[data-delete-draft]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.deleteDraft)
      discarded[index] = true
      el.draftFlashcardsContainer.querySelector(`[data-draft-card="${index}"]`)?.remove()
      updateSaveAllVisibility()
    })
  })

  el.saveAllDraftFlashcardsBtn.onclick = async () => {
    const pending = cards
      .map((card, i) => ({ card, i }))
      .filter(({ i }) => !savedFlags[i] && !discarded[i])
    if (!pending.length) return
    el.saveAllDraftFlashcardsBtn.disabled = true
    el.saveAllDraftFlashcardsBtn.textContent = 'Saving…'
    try {
      await api.saveFlashcards({
        category, sourceQuestionId,
        flashcards: pending.map(({ card }) => ({ term: card.term, definition: card.definition })),
      })
      pending.forEach(({ i }) => {
        savedFlags[i] = true
        const cardBtn = el.draftFlashcardsContainer.querySelector(`[data-save-draft="${i}"]`)
        if (cardBtn) {
          cardBtn.disabled = true
          cardBtn.textContent = 'Saved'
        }
      })
      updateSaveAllVisibility()
    } catch (error) {
      el.saveAllDraftFlashcardsBtn.disabled = false
      el.saveAllDraftFlashcardsBtn.textContent = 'Save All'
      el.draftFlashcardsContainer.insertAdjacentHTML(
        'beforeend', `<p class="text-red-400">${escapeHtml(error.message)}</p>`)
    }
  }

  updateSaveAllVisibility()
}

el.createFlashcardBtn.addEventListener('click', async () => {
  if (!question) return
  const asked = questionGeneration
  // Pinned here, not read again when Save is pressed. These cards are about
  // *this* tossup however long the player leaves them on screen, and reading
  // `question` at save time filed them under whatever happened to be loaded
  // by then -- a card about one question, recorded as having come from
  // another, which the notebook then groups and labels by.
  const source = { id: question.id, category: question.category }
  el.createFlashcardBtn.disabled = true
  el.draftFlashcardsContainer.textContent = 'Asking the AI…'
  try {
    const { cards } = await api.generateFlashcards(question.id)
    if (asked !== questionGeneration) return    // see getExplanationBtn above
    paintDraftCards(cards, source.category, source.id)
  } catch (error) {
    if (asked !== questionGeneration) return
    el.draftFlashcardsContainer.textContent = error.message
  } finally {
    el.createFlashcardBtn.disabled = false
  }
})

// ------------------------------------------------------------------- stats --

function paintSessionStats() {
  const avgCelerity = sessionStats.correctCount
    ? (sessionStats.celeritySum / sessionStats.correctCount).toFixed(3) : '0.000'
  el.ptn.textContent = `${sessionStats.powers} / ${sessionStats.tens} / ${sessionStats.negs}`
  el.tossupsHeard.textContent = sessionStats.heard
  el.pointsScored.textContent = sessionStats.points
  el.celerity.textContent = avgCelerity
}

function resetSessionStats() {
  sessionStats = { heard: 0, powers: 0, tens: 0, negs: 0, points: 0, celeritySum: 0, correctCount: 0 }
  paintSessionStats()
}

function recordSessionAnswer(result) {
  sessionStats.heard += 1
  sessionStats.points += result.points
  // Celerity only accumulates for an actual correct buzz -- same as the
  // desktop's own `stats.celeritySum`/`correctCount`, and the same reason the
  // server's own lifetime average filters to power/ten and leaves negs out:
  // a neg's celerity says how early you were wrong, not how well you did.
  if (result.outcome === 'power' || result.outcome === 'ten') {
    if (result.outcome === 'power') sessionStats.powers += 1
    else sessionStats.tens += 1
    if (result.celerity != null) {
      sessionStats.celeritySum += result.celerity
      sessionStats.correctCount += 1
    }
  } else if (result.outcome === 'neg') {
    sessionStats.negs += 1
  }
  paintSessionStats()
}

// -------------------------------------------------------- save a highlight --

/** The phrase currently selected inside the tossup, or ''. */
function selectedClue() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return ''
  // Only a selection that actually lies inside the question text counts --
  // selecting the answerline in the feedback box, or a menu label, is not a
  // clue and would otherwise be saved as one.
  if (!el.questionContainer.contains(selection.anchorNode)) return ''
  return selection.toString().trim()
}

document.addEventListener('selectionchange', () => {
  const has = Boolean(question) && selectedClue().length > 2
  el.saveHighlightBtn.classList.toggle('hidden', !has)
  if (has) {
    el.saveHighlightBtn.disabled = false
    el.saveHighlightBtn.textContent = 'Save Highlight'
  }
})

el.saveHighlightBtn.addEventListener('click', async () => {
  const clueText = selectedClue()
  if (!clueText || !question) return

  el.saveHighlightBtn.disabled = true
  el.saveHighlightBtn.textContent = 'Saving…'
  try {
    // Only the text and which question it came from. The answerline and the
    // shelf are both worked out server-side from the question id -- see
    // routes/notebook.py -- so a clue saved mid-tossup still files correctly
    // even though this page has not been told the answer yet.
    await api.saveClue({ clueText, sourceQuestionId: question.id })
    el.saveHighlightBtn.textContent = 'Saved'
    toast('Clue saved to your notebook')
    // Which shelf this landed on is worked out server-side (see the comment
    // above), so this module can't invalidate just that one -- clear the
    // notebook's whole shelf cache rather than let a shelf visited later this
    // session serve a clue count from before this save.
    notebook.resetShelfCache()
  } catch (error) {
    // Same as Add to Missed above: give the control back and put the message
    // where a sentence fits. `selectionchange` would eventually reset this,
    // but only once the player selects something else -- retrying the
    // highlight they are actually looking at should not require that.
    el.saveHighlightBtn.disabled = false
    el.saveHighlightBtn.textContent = 'Save Highlight'
    toast(error.message)
  }
})

// ------------------------------------------------------- adaptive learning --

/** Build the subject picker from what the server says it can actually serve.
 *
 * Not a hardcoded list: the recommender only works on subjects that have a
 * real topic clustering behind them, and which those are is a property of the
 * question set rather than of the app. `inProgress` is what the user has
 * already built up, so a subject they have played reads as somewhere to
 * return to instead of as a fresh start.
 */
/** Draw the subject picker from a catalogue payload. */
function paintAdaptiveCatalogue(catalogue) {
  adaptiveCatalogue = catalogue
  el.adaptiveCategorySelect.innerHTML = ''
  for (const category of catalogue.categories) {
    const group = document.createElement('optgroup')
    group.label = category.name

    // The general category itself, which stands for all of its shelves.
    const all = new Option(`${category.name} — all subjects`, category.name)
    group.append(all)

    for (const sub of category.subcategories) {
      const saved = catalogue.inProgress?.[sub.name]
      group.append(new Option(
        saved
          ? `  ${sub.name} (${sub.clusters} topics · ${saved.questionsServed} seen)`
          : `  ${sub.name} (${sub.clusters} topics)`,
        sub.name))
    }
    el.adaptiveCategorySelect.append(group)
  }
}

/** The Adaptive Learning subject list, from the last known copy first.
 *
 *  Same reasoning as `loadFilters`, and it matters more here: the subject list
 *  is the *first* thing on the Adaptive Learning screen, so a round trip to
 *  fetch it is a round trip spent looking at an empty picker with nothing to
 *  choose from. Nearly all of the payload -- which subjects exist, and how many
 *  topic clusters each has -- is a property of the question set, identical for
 *  everybody and unchanged until the database is rebuilt.
 *
 *  The one part that *is* per-account and does move is `inProgress` ("42 seen"),
 *  so the cached copy is only ever the first paint: the request still goes out
 *  and repaints when anything differs. A count that is a few hundred
 *  milliseconds stale on the way in is worth an instant picker; a picker that
 *  isn't there yet is not.
 */
async function loadAdaptiveCatalogue() {
  if (adaptiveCatalogue) return adaptiveCatalogue

  let cached = null
  try { cached = JSON.parse(localStorage.getItem(ADAPTIVE_CACHE)) } catch { cached = null }
  if (cached?.categories?.length) paintAdaptiveCatalogue(cached)

  const fresh = await api.adaptiveCategories()
  const serialised = JSON.stringify(fresh)
  // Skipped when nothing changed: repainting rebuilds the <select> and would
  // drop a subject the player had already started ticking.
  if (serialised !== JSON.stringify(cached)) {
    paintAdaptiveCatalogue(fresh)
    try { localStorage.setItem(ADAPTIVE_CACHE, serialised) } catch { /* full or blocked */ }
  } else {
    adaptiveCatalogue = fresh
  }
  return adaptiveCatalogue
}

/** An even split across `n` picks that still sums to exactly 100 -- the
 *  remainder (100 % n) goes to the first picks rather than getting dropped,
 *  e.g. 3 picks -> 34/33/33, not 33/33/33 (which is 99). */
function evenPercentages(n) {
  const base = Math.floor(100 / n)
  const remainder = 100 - base * n
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0))
}

/** One typed percentage per pick, shown only when there is a split to make.
 *
 * A slider you drag moves every other pick's *share* out from under it
 * without touching their own numbers, which reads as the split shifting on
 * its own. Typing an exact percentage per pick is the opposite: nothing
 * moves unless you move it, and the total simply has to reach 100 before
 * Start Session unlocks. */
function refreshAdaptiveWeights() {
  const picks = chosen(el.adaptiveCategorySelect)
  el.startAdaptiveSessionBtn.disabled = picks.length === 0
  el.adaptiveWeightsWrap.classList.toggle('hidden', picks.length < 2)
  if (picks.length < 2) return

  const existing = new Map(
    [...el.adaptiveWeights.querySelectorAll('input')].map((i) => [i.dataset.name, i.value]))

  el.adaptiveWeights.innerHTML = ''
  const evenSplit = evenPercentages(picks.length)
  picks.forEach((name, i) => {
    const row = document.createElement('div')
    row.className = 'mt-1 flex items-center justify-between gap-3 text-xs text-[#baa7a1]'
    row.innerHTML = `
      <span class="flex-1 truncate">${escapeHtml(name)}</span>
      <div class="flex flex-shrink-0 items-center gap-1">
        <input type="number" min="0" max="100" step="1" inputmode="numeric"
               data-name="${escapeHtml(name)}"
               value="${existing.get(name) ?? evenSplit[i]}"
               class="w-16 rounded-lg border border-[#584741] bg-[#1d1816] p-1 text-right text-white focus:border-[#efe0db] focus:outline-none">
        <span>%</span>
      </div>`
    el.adaptiveWeights.append(row)
  })
  paintAdaptiveShares()
}

/** Just the running total -- typing doesn't have to land on exactly 100
 *  before Start Session works. The numbers are sent to the server as relative
 *  weights either way, so 96 or 104 splits the same as 96/104 scaled to 100
 *  would; this is a readout, not a gate. */
function paintAdaptiveShares() {
  const inputs = [...el.adaptiveWeights.querySelectorAll('input')]
  const total = inputs.reduce((sum, i) => sum + (Number(i.value) || 0), 0)
  el.adaptiveWeightTotal.textContent = `Total: ${total}%`
  el.adaptiveWeightTotal.className = total === 100
    ? 'mt-2 text-xs font-bold text-green-400'
    : 'mt-2 text-xs font-bold text-[#f6b17a]'
}

el.adaptiveCategorySelect.addEventListener('change', refreshAdaptiveWeights)
el.adaptiveWeights.addEventListener('input', paintAdaptiveShares)
el.resetAdaptiveWeightsBtn.addEventListener('click', () => {
  const inputs = [...el.adaptiveWeights.querySelectorAll('input')]
  const split = evenPercentages(inputs.length)
  inputs.forEach((input, i) => { input.value = split[i] })
  paintAdaptiveShares()
})

el.adaptiveLearningBtn.addEventListener('click', async () => {
  showScreen('adaptiveSetupScreen')
  el.adaptiveSetupMessage.textContent = ''
  try {
    await loadAdaptiveCatalogue()
    refreshAdaptiveWeights()
  } catch (error) {
    el.adaptiveSetupMessage.textContent = error.message
  }
})

el.cancelAdaptiveBtn.addEventListener('click', openReader)

el.startAdaptiveSessionBtn.addEventListener('click', () => {
  const picks = chosen(el.adaptiveCategorySelect)
  if (!picks.length) return

  const sliders = [...el.adaptiveWeights.querySelectorAll('input')]
  const weights = picks.length < 2
    ? picks.map(() => 1)
    : picks.map((name) => {
        const slider = sliders.find((s) => s.dataset.name === name)
        return slider ? Number(slider.value) : 1
      })

  if (reviewMode) leaveReview()
  resetSessionStats()
  adaptive = {
    picks, weights,
    // Its own session id, not the page's. /api/adaptive/end counts the sitting
    // out of user_stats by session_id, so sharing the page-wide one made the
    // summary include every ordinary tossup answered before the session began
    // -- a Save & Quit after one adaptive question reported two answered.
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    answered: 0, correct: 0,
    restoreKey: null, skill: null, subject: null,
    // Captured once, from the first question's `adaptive.skill` -- see the
    // comment where it's set, and routes/adaptive.py's /end for why this
    // can't just be re-derived server-side from category_user_state.
    startSkill: null,
  }
  el.adaptiveSessionStats.classList.remove('hidden')
  paintAdaptiveStats()
  openReader()
  nextAdaptiveQuestion()
})

function nextAdaptiveQuestion() {
  loadQuestion(() => api.adaptiveQuestion(adaptive.picks, adaptive.weights))
}

function paintAdaptiveStats() {
  if (!adaptive) return
  el.adaptiveSubject.textContent = adaptive.subject ?? '—'
  el.adaptiveSkill.textContent = adaptive.skill == null ? '—' : adaptive.skill.toFixed(2)
  el.adaptiveAnswered.textContent = adaptive.answered
  el.adaptiveCorrect.textContent = adaptive.correct
  el.adaptiveAccuracy.textContent = adaptive.answered
    ? `${Math.round((adaptive.correct / adaptive.answered) * 100)}%`
    : '0%'
}

el.saveAndQuitAdaptiveBtn.addEventListener('click', async () => {
  if (!adaptive) return
  const { restoreKey } = adaptive
  el.saveAndQuitAdaptiveBtn.disabled = true
  try {
    // Nothing is flushed here -- the skill model was written on every question
    // and every answer, so closing the tab loses none of it. This only records
    // the session summary that the Records page lists.
    if (restoreKey) {
      await api.adaptiveEnd(restoreKey, adaptive.sessionId, adaptive.startedAt, adaptive.startSkill)
    }
  } catch (error) {
    // The save failed, so the sitting will not appear in Records. This used to
    // log to the console and end the session in a `finally` anyway: the player
    // pressed Save & Quit, the record was silently not written, the session was
    // torn down, and nothing on screen said so. Recording the sitting is the
    // entire job of this button, so a failure has to be visible and the session
    // has to survive for a second try.
    el.saveAndQuitAdaptiveBtn.disabled = false
    showFeedback(
      `Could not save this session: ${escapeHtml(error.message)}. ` +
      'Your skill progress is already saved — only the Records entry failed. ' +
      'Press Save &amp; Quit again to retry.', false)
    return
  }
  el.saveAndQuitAdaptiveBtn.disabled = false
  leaveAdaptive()
  abandonTossup()
  el.questionContainer.textContent = idlePrompt()
  toast('Session saved to Records')
})

function leaveAdaptive() {
  adaptive = null
  el.adaptiveSessionStats.classList.add('hidden')
  el.adaptiveResumed.classList.add('hidden')
}

// ---------------------------------------------------------------- settings --

// Every shortcut the reader actually handles, written out once so the two
// places that list them cannot drift apart from each other or from the handler.
const SHORTCUTS = [
  ['Space / B', 'Buzz'],
  ['Enter', 'Submit your answer'],
  ['S', 'Start Reader'],
  ['N', 'Next question'],
  ['A', 'Adaptive Learning'],
  ['P', 'Pause or resume'],
  ['E', 'Get AI explanation'],
  ['?', 'This list'],
]

function paintShortcutLists() {
  const html = SHORTCUTS.map(([key, what]) => `
    <div class="flex items-baseline justify-between gap-4">
      <dt class="font-mono text-amber-400">${escapeHtml(key)}</dt>
      <dd class="text-right text-text-muted">${escapeHtml(what)}</dd>
    </div>`).join('')
  el.shortcutListSettings.innerHTML = html
  el.shortcutListAbout.innerHTML = html
}
paintShortcutLists()

// Font size and the shortcut switch are local prefs, kept in localStorage
// under PREFS, which is declared with the rest of the state at the top of this
// file -- see the note there.

function loadPrefs() {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(PREFS)) ?? {} } catch { saved = {} }
  applyFontSize(saved.fontSize ?? 16)
  el.shortcutsToggle.checked = saved.shortcuts !== false
  el.allowRebuzzToggle.checked = saved.allowRebuzz === true
  allowRebuzz = el.allowRebuzzToggle.checked
  if (saved.readingSpeed) {
    el.readingSpeed.value = saved.readingSpeed
    updateSpeedDisplay()
  }
  if (saved.powermark === false) {
    el.powerHighlightToggle.checked = false
    document.body.classList.add('no-power')
  }
}

function savePrefs() {
  localStorage.setItem(PREFS, JSON.stringify({
    fontSize: Number(el.fontSizeRange.value),
    shortcuts: el.shortcutsToggle.checked,
    readingSpeed: Number(el.readingSpeed.value),
    powermark: el.powerHighlightToggle.checked,
    allowRebuzz: el.allowRebuzzToggle.checked,
    categories: chosen(el.categorySelect),
    subcategories: chosen(el.subcategorySelect),
    difficulties: chosen(el.difficultySelect),
    // A handle parked on the end of the span is stored as null -- "open" --
    // not as the year it happens to be sitting on. The two are the same today
    // and diverge the moment the bank grows: storing 2025 because 2025 was the
    // newest year on screen means a player who never touched the slider is
    // silently filtered to `yearMax=2025` forever after, never sees a 2026
    // question, and has nothing on screen to say why. A genuinely narrowed
    // end is still a choice and still persists.
    yearMin: yearBounds && Number(el.yearMin.value) <= yearBounds.min
      ? null : Number(el.yearMin.value),
    yearMax: yearBounds && Number(el.yearMax.value) >= yearBounds.max
      ? null : Number(el.yearMax.value),
  }))
}

/** Scales the whole interface, not just the tossup: every size in the app is
 *  in rem, which is relative to the root font size, so text and the spacing
 *  around it grow together instead of text overflowing boxes that stayed put. */
function applyFontSize(px) {
  el.fontSizeRange.value = px
  el.fontSizeDisplay.textContent = `${px}px`
  document.documentElement.style.fontSize = `${px}px`
}

function openSettings() {
  el.settingsModal.classList.remove('hidden')
  el.settingsModal.classList.add('flex')
  loadAccountEmail()
}
el.settingsBtn.addEventListener('click', openSettings)

function closeSettings() {
  el.settingsModal.classList.add('hidden')
  el.settingsModal.classList.remove('flex')
}

el.closeSettingsBtn.addEventListener('click', closeSettings)
el.settingsModal.addEventListener('click', (event) => {
  // Only the backdrop itself, not a click that happened to bubble out of the
  // dialog -- dragging the font slider and releasing outside the panel would
  // otherwise close it mid-adjustment.
  if (event.target === el.settingsModal) closeSettings()
})

// Applied live while dragging and saved immediately: a font size you cannot
// see until you press Save is a guess.
el.fontSizeRange.addEventListener('input', () => {
  applyFontSize(Number(el.fontSizeRange.value))
  savePrefs()
})
el.fontSizeResetBtn.addEventListener('click', () => { applyFontSize(16); savePrefs() })
el.shortcutsToggle.addEventListener('change', savePrefs)
el.allowRebuzzToggle.addEventListener('change', () => {
  allowRebuzz = el.allowRebuzzToggle.checked
  savePrefs()
})
el.readingSpeed.addEventListener('change', savePrefs)
el.powerHighlightToggle.addEventListener('change', savePrefs)

let toastTimer = null
function toast(message) {
  el.shortcutToast.textContent = message
  el.shortcutToast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.shortcutToast.classList.add('hidden'), 1400)
}

loadPrefs()
