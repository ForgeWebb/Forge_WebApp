/**
 * The notebook: shelves, study guides, per-question notes, clues, flashcards.
 *
 * Two screens and two dialogs, following the desktop's shape -- a hub of
 * category tiles, then one shelf at a time with guides and clues on the left
 * and flashcards on the right.
 *
 * The one structural decision worth stating: **a shelf is loaded in one go.**
 * Opening a category fetches its notes, clues and cards as three parallel
 * requests and renders from what comes back, rather than fetching a list and
 * then a detail per row. The backend was written the same way (see the N+1
 * notes in routes/notebook.py), and it would be a shame to undo that in the
 * client by asking per item.
 */

import { api } from './api.js'
import { renderMarkdown } from './markdown.js'

const escapeHtml = (text) => String(text ?? '').replace(
  /[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const $ = (id) => document.getElementById(id)

export function initNotebook({ onBack }) {
  const el = {
    hubScreen: $('notebookHubScreen'), hubList: $('notebookHubList'),
    hubEmpty: $('notebookHubEmpty'),
    detailScreen: $('notebookDetailScreen'), detailTitle: $('notebookDetailTitle'),
    search: $('notebookSearch'), searchCount: $('notebookSearchCount'),

    mergeBar: $('mergeBar'), mergeCount: $('mergeCount'),
    mergeCancelBtn: $('mergeCancelBtn'), mergeNotesBtn: $('mergeNotesBtn'),
    mergeDeleteOriginals: $('mergeDeleteOriginals'),
    exportSelectedNotesBtn: $('exportSelectedNotesBtn'),

    guidesSection: $('guidesSection'), guidesList: $('guidesList'),
    generateGuideBtn: $('generateGuideBtn'), generateGuideStatus: $('generateGuideStatus'),
    exportNotesBtn: $('exportNotesBtn'),
    notesSection: $('notesSection'), notesList: $('notesList'),
    notesEmpty: $('notesEmpty'),

    clueCount: $('clueCount'), cluesList: $('cluesList'),
    deleteAllCluesBtn: $('deleteAllCluesBtn'),

    cardsList: $('cardsList'), cardCount: $('cardCount'),
    addFlashcardBtn: $('addFlashcardBtn'), deleteAllFlashcardsBtn: $('deleteAllFlashcardsBtn'),
    exportFlashcardsBtn: $('exportFlashcardsBtn'),
    cardPickBar: $('cardPickBar'), cardPickCount: $('cardPickCount'),
    cardPickClearBtn: $('cardPickClearBtn'),
    exportSelectedFlashcardsBtn: $('exportSelectedFlashcardsBtn'),

    viewer: $('noteViewerModal'), viewerTitle: $('modalNoteTitle'),
    viewerSubtitle: $('modalNoteSubtitle'), viewerContent: $('modalNoteContent'),
    viewerEditor: $('modalNoteEditor'), viewerStatus: $('noteEditStatus'),
    closeViewerBtn: $('closeNoteViewerBtn'), editNoteBtn: $('editNoteBtn'),
    saveNoteChangesBtn: $('saveNoteChangesBtn'), cancelNoteEditBtn: $('cancelNoteEditBtn'),
    deleteNoteBtn: $('deleteNoteBtn'),

    nameModal: $('guideNameModal'), nameHeading: $('guideNameHeading'),
    nameSubtitle: $('guideNameSubtitle'), nameInput: $('guideNameInput'),
    nameError: $('guideNameError'), nameTargetWrap: $('guideTargetWrap'),
    nameTargetSelect: $('guideTargetSelect'),
    nameCancelBtn: $('guideNameCancelBtn'), nameConfirmBtn: $('guideNameConfirmBtn'),
  }

  // The shelf currently open, and everything on it. Held so the search box can
  // filter without refetching -- it hides rows that are already rendered.
  let shelf = null
  let notes = []
  let clues = []
  let cards = []
  let shelfRequest = 0

  // Every shelf visited this notebook visit, keyed by category, so flicking
  // hub -> shelf -> hub -> the same shelf again doesn't pay three fresh round
  // trips for data that was on screen a moment ago -- the same complaint the
  // Browse screen's page cache exists to fix (see browse.js's `pageCache`).
  //
  // Kept narrower than that one in one way: a shelf's own mutations (delete a
  // clue, merge notes, add a card...) invalidate only *that* shelf's entry
  // rather than clearing everything, since shelves don't share rows the way
  // Browse's pages of the same query do. `invalidateShelf` is the one place
  // that happens, called right before every mutation reloads.
  //
  // It does NOT get cleared just because the hub is opened again -- back-and-
  // forth between the hub and a shelf is exactly the navigation this is meant
  // to make instant. What it can't see is a clue saved from the *Reader*
  // screen mid-tossup ("Save Highlight" in main.js) -- that writes into
  // whichever shelf the question's category resolves to, server-side, without
  // this module ever hearing about it. `resetShelfCache` (returned below) is
  // the escape hatch main.js calls after that succeeds, since which shelf it
  // landed in isn't known here.
  const shelfCache = new Map()
  function invalidateShelf() { shelfCache.delete(shelf) }
  let selected = new Set()
  // Ticked flashcards, for "Export selected". Kept separate from `selected`
  // (which is notes, and doubles as the merge selection) -- the two columns
  // are picked independently and a card can never be a merge target.
  let pickedCards = new Set()
  let openNote = null

  // ------------------------------------------------------------------ hub --

  async function openHub() {
    show('hubScreen')
    el.hubList.innerHTML = '<p class="text-text-muted">Loading…</p>'
    try {
      const { categories } = await api.notebookCategories()
      el.hubEmpty.classList.toggle('hidden', categories.length > 0)
      el.hubList.innerHTML = categories.map((c) => {
        const bits = [
          c.notes ? `${c.notes} note${c.notes === 1 ? '' : 's'}` : null,
          c.flashcards ? `${c.flashcards} card${c.flashcards === 1 ? '' : 's'}` : null,
          c.clues ? `${c.clues} clue${c.clues === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ')
        return `
          <button data-category="${escapeHtml(c.category)}"
                  class="flex w-full items-center justify-between rounded-lg bg-secondary-dark p-4 text-left hover:bg-tertiary-dark">
            <span class="font-bold">${escapeHtml(c.category)}</span>
            <span class="text-sm text-text-muted">${escapeHtml(bits)}</span>
          </button>`
      }).join('')
    } catch (error) {
      el.hubList.innerHTML = `<p class="text-red-400">${escapeHtml(error.message)}</p>`
    }
  }

  el.hubList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]')
    if (button) openShelf(button.dataset.category)
  })

  // ---------------------------------------------------------------- shelf --

  async function openShelf(category) {
    shelf = category
    selected.clear()
    // Card ids are shelf-specific, so a leftover pick from the last shelf
    // would export a card that isn't on screen any more.
    pickedCards.clear()
    show('detailScreen')
    el.detailTitle.textContent = category
    el.search.value = ''

    const cached = shelfCache.get(category)
    if (cached) {
      notes = cached.notes
      clues = cached.clues
      cards = cached.cards
      paintNotes()
      paintClues()
      paintCards()
      return
    }

    el.notesList.innerHTML = '<p class="text-text-muted">Loading…</p>'
    el.cluesList.innerHTML = ''
    el.cardsList.innerHTML = ''

    // Three requests in parallel rather than in sequence: they do not depend on
    // each other, and awaiting them one at a time is three round trips of
    // latency for no reason.
    const requestId = ++shelfRequest
    const [noteResult, clueResult, cardResult] = await Promise.allSettled([
      api.notes(category), api.clues(category), api.flashcards(category),
    ])
    // A quick second shelf click before this one lands must not paint the
    // stale shelf's data over the new one's title.
    if (requestId !== shelfRequest) return
    notes = noteResult.status === 'fulfilled' ? noteResult.value.notes : []
    clues = clueResult.status === 'fulfilled' ? clueResult.value.clues : []
    cards = cardResult.status === 'fulfilled' ? cardResult.value.flashcards : []
    // Only cached once every leg actually succeeded -- a partial failure (say,
    // the clues request alone dropped) must not get remembered as "this shelf
    // has no clues" for the rest of the visit.
    if (noteResult.status === 'fulfilled' && clueResult.status === 'fulfilled' &&
        cardResult.status === 'fulfilled') {
      shelfCache.set(category, { notes, clues, cards })
    }

    paintNotes()
    paintClues()
    paintCards()
  }

  function noteTitle(note) {
    return note.title || note.answer_text || 'Untitled'
  }

  // Case-insensitive, locale-aware -- plain `<` would sort "Zeus" before
  // "abraham lincoln", which is not what anyone reading an alphabetical list
  // of answerlines expects.
  const byTitle = (a, b) =>
    noteTitle(a).localeCompare(noteTitle(b), undefined, { sensitivity: 'base' })

  function paintNotes() {
    const guides = notes.filter((n) => n.is_merged).sort(byTitle)
    const singles = notes.filter((n) => !n.is_merged).sort(byTitle)

    el.guidesSection.classList.toggle('hidden', guides.length === 0)
    el.notesSection.classList.toggle('hidden', singles.length === 0)
    el.notesEmpty.classList.toggle('hidden', notes.length > 0)
    el.exportNotesBtn.classList.toggle('hidden', notes.length === 0)
    if (!notes.length) {
      el.notesEmpty.innerHTML =
        `<p class="text-sm text-text-muted">Nothing saved here yet. Highlight a clue while
         reading and press <span class="font-bold text-text-light">Save Highlight</span>,
         and it turns up under Saved Clues.</p>`
    }

    el.guidesList.innerHTML = guides.map((n) => `
      <div data-note-row="${n.id}" class="rounded-lg bg-secondary-dark p-3">
        <button data-open-note="${n.id}" class="w-full text-left">
          <span class="font-bold text-sky-400">${escapeHtml(noteTitle(n))}</span>
          <span class="ml-2 text-xs text-text-muted">${sectionCount(n)}</span>
        </button>
      </div>`).join('')

    // Per-question notes carry a checkbox: two or more of them can be rolled
    // up into a guide, which is the point of keeping them separately at all.
    el.notesList.innerHTML = singles.map((n) => `
      <div data-note-row="${n.id}" class="flex items-start gap-2 rounded-lg bg-secondary-dark p-3">
        <input type="checkbox" data-pick="${n.id}" class="mt-1 h-4 w-4 shrink-0 accent-sky-500"
               ${selected.has(n.id) ? 'checked' : ''}>
        <button data-open-note="${n.id}" class="flex-1 text-left">
          <span class="font-bold">${escapeHtml(noteTitle(n))}</span>
          ${n.difficulty != null
            ? `<span class="ml-2 text-xs text-text-muted">difficulty ${n.difficulty}</span>` : ''}
        </button>
      </div>`).join('')

    paintMergeBar()
    applySearch()
  }

  const sectionCount = (note) => {
    const n = (note.notes_content || '').split(/\n\s*---\s*\n/).length
    return `${n} section${n === 1 ? '' : 's'}`
  }

  function paintClues() {
    el.clueCount.textContent = clues.length ? `(${clues.length})` : ''
    el.deleteAllCluesBtn.classList.toggle('hidden', clues.length === 0)

    if (!clues.length) {
      el.cluesList.innerHTML =
        '<p class="text-sm text-text-muted">No clues saved on this shelf yet.</p>'
      return
    }

    // Grouped by the answer they point at, which is what makes a pile of clues
    // into something you can revise from.
    const groups = new Map()
    for (const clue of clues) {
      const key = clue.answer_text || 'Unattributed'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(clue)
    }

    el.cluesList.innerHTML = [...groups].map(([answer, items]) => `
      <div data-clue-group class="rounded-lg bg-secondary-dark p-3">
        <p class="mb-2 text-sm font-bold text-[#f6b17a]">${escapeHtml(answer)}</p>
        ${items.map((c) => `
          <div data-clue-row class="mb-1 flex items-start gap-2 text-sm">
            <span class="flex-1 text-text-muted">${escapeHtml(c.clue_text)}</span>
            <button data-delete-clue="${c.id}"
                    class="shrink-0 text-xs text-red-400 hover:text-red-300"
                    title="Remove this clue">✕</button>
          </div>`).join('')}
      </div>`).join('')
  }

  /** One group's worth of card rows -- the same checkbox/term/definition/
   *  delete a flat list always had, just no longer repeating "from <answer>"
   *  on every row now that the group heading already says it. */
  function cardRow(c) {
    return `
      <div class="flex items-start justify-between gap-3 rounded-lg bg-tertiary-dark p-3">
        <div class="flex flex-1 items-start gap-2">
          <input type="checkbox" data-card-pick="${c.id}"
                 class="mt-1 h-4 w-4 shrink-0 accent-sky-500"
                 ${pickedCards.has(c.id) ? 'checked' : ''}>
          <div class="min-w-0 flex-1">
            <p class="font-bold">${escapeHtml(c.term)}</p>
            <p class="mt-1 text-sm text-text-muted">${escapeHtml(c.definition)}</p>
          </div>
        </div>
        <button data-delete-card="${c.id}"
                class="shrink-0 text-xs text-red-400 hover:text-red-300"
                title="Delete this card">✕</button>
      </div>`
  }

  // Condensed under one answerline per tossup, collapsed until clicked --
  // matching the desktop's own flashcard view (electron-app/renderer.js's
  // displayCategoryDetail). A shelf built from Adaptive Learning runs ten
  // cards deep per tossup, and a flat list repeating the same "from <answer>"
  // under every one of them was the thing this replaces.
  function paintCards() {
    el.cardCount.textContent = cards.length ? `(${cards.length})` : ''
    el.deleteAllFlashcardsBtn.classList.toggle('hidden', cards.length === 0)
    el.exportFlashcardsBtn.classList.toggle('hidden', cards.length === 0)

    if (!cards.length) {
      el.cardsList.innerHTML =
        '<p class="text-sm text-text-muted">No flashcards on this shelf yet.</p>'
      return
    }

    // Grouped by the tossup a card came from, not by answer text -- two
    // different questions can share an answerline, and grouping on the id
    // keeps them apart the way grouping on the string would not. A card with
    // no recorded source (older data, or a manually added one) falls into one
    // shared "Other cards" bucket rather than getting a group of its own per
    // card.
    const groups = new Map()
    for (const c of cards) {
      const key = c.source_question_id ?? 'other'
      if (!groups.has(key)) {
        groups.set(key, { answer: c.source_answer, difficulty: c.source_difficulty, cards: [] })
      }
      groups.get(key).cards.push(c)
    }

    // Alphabetical by answerline, "Other cards" last -- it has no answer to
    // sort by, and sorting the one bucket that isn't really a tossup in among
    // ones that are would put it at an arbitrary point in the middle of the
    // alphabet instead of clearly out of band.
    const sortedGroups = [...groups.entries()].sort(([, a], [, b]) =>
      (a.answer ?? '￿').localeCompare(b.answer ?? '￿', undefined, { sensitivity: 'base' }))

    el.cardsList.innerHTML = sortedGroups.map(([key, group]) => `
      <details data-card-row class="rounded-lg bg-secondary-dark">
        <summary class="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-4 py-3 hover:bg-tertiary-dark">
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate font-bold text-[#f6b17a]">${escapeHtml(group.answer || 'Other cards')}</span>
            ${group.difficulty != null
              ? `<span class="shrink-0 rounded-full bg-tertiary-dark px-2 py-0.5 text-xs font-bold text-text-muted"
                       title="Difficulty of the tossup these cards came from">difficulty ${group.difficulty}</span>` : ''}
          </span>
          <span class="flex shrink-0 items-center gap-3 text-xs text-text-muted">
            <span>${group.cards.length} card${group.cards.length === 1 ? '' : 's'}</span>
            <button data-select-group="${key}" class="text-accent-dark hover:underline"
                    title="Select or clear every card from this tossup">Select</button>
          </span>
        </summary>
        <div class="space-y-2 px-4 pb-4">
          ${group.cards.map(cardRow).join('')}
        </div>
      </details>`).join('')

    paintCardPickBar()
  }

  function paintCardPickBar() {
    el.cardPickCount.textContent = pickedCards.size
    el.cardPickBar.classList.toggle('hidden', pickedCards.size < 1)
  }

  // --------------------------------------------------------------- search --

  /** Hides rows already in the DOM rather than refetching. One box filters all
   *  three columns, the same as the desktop. */
  function applySearch() {
    const term = el.search.value.trim().toLowerCase()
    let shown = 0, total = 0

    for (const row of el.detailScreen.querySelectorAll(
      '[data-note-row], [data-clue-group], [data-card-row]')) {
      total++
      const match = !term || row.textContent.toLowerCase().includes(term)
      row.classList.toggle('hidden', !match)
      if (match) shown++
    }

    el.searchCount.classList.toggle('hidden', !term)
    el.searchCount.textContent = `${shown} of ${total} match “${el.search.value.trim()}”`
  }

  el.search.addEventListener('input', applySearch)

  // ------------------------------------------------------- guide generation --

  el.generateGuideBtn.addEventListener('click', async () => {
    el.generateGuideBtn.disabled = true
    el.generateGuideStatus.classList.remove('hidden')
    el.generateGuideStatus.textContent = 'Building a guide from your saved clues…'
    try {
      await api.generateGuide(shelf)
      el.generateGuideStatus.classList.add('hidden')
      invalidateShelf()
      await openShelf(shelf)
    } catch (error) {
      // ApiError.empty on a 404 with no clues -- an instruction, not a
      // failure -- and `no_key`, which on the website now means the
      // operator's shared key is unset (web/api/ai.py); both are read here,
      // since there is no longer a Settings box to send anyone to.
      el.generateGuideStatus.textContent = error.message
    } finally {
      el.generateGuideBtn.disabled = false
    }
  })

  // -------------------------------------------------------------- export --

  /** Runs a download and puts the button back the way it found it -- showing
   *  the error in the button's own label rather than a shared status line,
   *  since this shelf has three separate export buttons and no one place
   *  all of their failures naturally belong. */
  async function runExport(button, label, action) {
    button.disabled = true
    const original = button.textContent
    try {
      await action()
    } catch (error) {
      button.textContent = error.message
      setTimeout(() => { button.textContent = original }, 3000)
      return
    } finally {
      button.disabled = false
    }
    button.textContent = original
  }

  el.exportNotesBtn.addEventListener('click', () =>
    runExport(el.exportNotesBtn, 'Export', () => api.exportNotes(shelf)))

  el.exportFlashcardsBtn.addEventListener('click', () =>
    runExport(el.exportFlashcardsBtn, 'Export', () => api.exportFlashcards(shelf)))

  el.exportSelectedNotesBtn.addEventListener('click', () =>
    runExport(el.exportSelectedNotesBtn, 'Export selected',
      () => api.exportSelectedNotes([...selected])))

  el.exportSelectedFlashcardsBtn.addEventListener('click', () =>
    runExport(el.exportSelectedFlashcardsBtn, 'Export selected',
      () => api.exportSelectedFlashcards([...pickedCards])))

  el.cardsList.addEventListener('change', (event) => {
    const box = event.target.closest('[data-card-pick]')
    if (!box) return
    const id = Number(box.dataset.cardPick)
    if (box.checked) pickedCards.add(id)
    else pickedCards.delete(id)
    paintCardPickBar()
  })

  el.cardPickClearBtn.addEventListener('click', () => {
    pickedCards.clear()
    for (const box of el.cardsList.querySelectorAll('[data-card-pick]')) box.checked = false
    paintCardPickBar()
  })

  // ---------------------------------------------------------------- merge --

  function paintMergeBar() {
    el.mergeCount.textContent = selected.size
    // The bar itself is useful from one pick (export doesn't need a pair);
    // merging still does, so that button alone stays gated at two.
    el.mergeBar.classList.toggle('hidden', selected.size < 1)
    el.mergeNotesBtn.classList.toggle('hidden', selected.size < 2)
  }

  el.notesList.addEventListener('change', (event) => {
    const box = event.target.closest('[data-pick]')
    if (!box) return
    const id = Number(box.dataset.pick)
    if (box.checked) selected.add(id)
    else selected.delete(id)
    paintMergeBar()
  })

  el.mergeCancelBtn.addEventListener('click', () => {
    selected.clear()
    for (const box of el.notesList.querySelectorAll('[data-pick]')) box.checked = false
    paintMergeBar()
  })

  el.mergeNotesBtn.addEventListener('click', () => {
    const guides = notes.filter((n) => n.is_merged)
    el.nameHeading.textContent = 'What do you want to name it?'
    el.nameSubtitle.textContent =
      `${selected.size} notes will be rolled into one guide, sorted A–Z by answerline.`
    el.nameInput.value = ''
    el.nameError.classList.add('hidden')

    // A guide can be started or grown. Hidden entirely when there are none yet,
    // because "add to an existing guide" with nothing to add to is a dead
    // control that only raises a question.
    el.nameTargetWrap.classList.toggle('hidden', guides.length === 0)
    el.nameTargetSelect.innerHTML =
      '<option value="__new__">➕ A new guide…</option>' +
      guides.map((g) => `<option value="${g.id}">${escapeHtml(noteTitle(g))}</option>`).join('')

    openModal(el.nameModal)
    el.nameInput.focus()
  })

  el.nameTargetSelect.addEventListener('change', () => {
    const appending = el.nameTargetSelect.value !== '__new__'
    el.nameInput.classList.toggle('hidden', appending)
    el.nameConfirmBtn.textContent = appending ? 'Add to guide' : 'Create Guide'
  })

  el.nameCancelBtn.addEventListener('click', () => closeModal(el.nameModal))

  el.nameConfirmBtn.addEventListener('click', async () => {
    const target = el.nameTargetSelect.value
    const noteIds = [...selected]
    const deleteOriginals = el.mergeDeleteOriginals.checked
    el.nameError.classList.add('hidden')
    el.nameConfirmBtn.disabled = true

    try {
      if (target === '__new__') {
        const title = el.nameInput.value.trim()
        if (!title) throw new Error('Give the guide a name.')
        await api.mergeGuide({ title, noteIds, deleteOriginals, category: shelf })
      } else {
        await api.appendGuide(Number(target), { noteIds, deleteOriginals })
      }
      closeModal(el.nameModal)
      selected.clear()
      invalidateShelf()
      await openShelf(shelf)
    } catch (error) {
      el.nameError.textContent = error.message
      el.nameError.classList.remove('hidden')
    } finally {
      el.nameConfirmBtn.disabled = false
    }
  })

  // ---------------------------------------------------------- note viewer --

  /** Report a failed row action on the button itself, then give it back.
   *
   *  These two used to set the label to '!' and leave the button disabled, so
   *  a delete that failed for any reason -- a dropped connection is enough --
   *  left a dead control with a one-character message and no way to try again
   *  short of reloading the page. The row is still there and still deletable;
   *  the only thing that had actually failed was one request. Same shape as
   *  the copy button above: say so, hand the control back, put the label
   *  right again a moment later. The real message goes on `title` because
   *  these buttons are single-glyph and have nowhere to print a sentence.
   */
  function failedRowAction(button, error, label) {
    button.disabled = false
    button.textContent = '!'
    button.title = error.message
    setTimeout(() => {
      button.textContent = label
      button.title = ''
    }, 3000)
  }

  el.detailScreen.addEventListener('click', async (event) => {
    const openBtn = event.target.closest('[data-open-note]')
    if (openBtn) return showNote(Number(openBtn.dataset.openNote))

    const selectGroupBtn = event.target.closest('[data-select-group]')
    if (selectGroupBtn) {
      // Sits inside a <summary>, which toggles the group open/closed on any
      // click within it -- without this, picking a group would also fold it.
      event.preventDefault()
      const boxes = selectGroupBtn.closest('details')
        .querySelectorAll('input[data-card-pick]')
      const allChecked = boxes.length > 0 && [...boxes].every((b) => b.checked)
      for (const box of boxes) {
        box.checked = !allChecked
        const id = Number(box.dataset.cardPick)
        if (box.checked) pickedCards.add(id)
        else pickedCards.delete(id)
      }
      paintCardPickBar()
      return
    }

    const clueBtn = event.target.closest('[data-delete-clue]')
    if (clueBtn) {
      const id = Number(clueBtn.dataset.deleteClue)
      const label = clueBtn.textContent
      clueBtn.disabled = true
      try {
        await api.deleteClue(id)
        clues = clues.filter((c) => c.id !== id)
        invalidateShelf()
        paintClues()
        applySearch()
      } catch (error) { failedRowAction(clueBtn, error, label) }
      return
    }

    const cardBtn = event.target.closest('[data-delete-card]')
    if (cardBtn) {
      const id = Number(cardBtn.dataset.deleteCard)
      const label = cardBtn.textContent
      cardBtn.disabled = true
      try {
        await api.deleteFlashcard(id)
        cards = cards.filter((c) => c.id !== id)
        // Dropping it from the pick set too: exporting "selected" must not
        // carry an id that no longer exists.
        pickedCards.delete(id)
        invalidateShelf()
        paintCards()
        applySearch()
      } catch (error) { failedRowAction(cardBtn, error, label) }
    }
  })

  async function showNote(id) {
    openNote = notes.find((n) => n.id === id)
    if (!openNote) return

    el.viewerTitle.textContent = noteTitle(openNote)
    el.viewerSubtitle.textContent = [
      openNote.is_merged ? 'Study guide' : 'Question note',
      openNote.subcategory, openNote.category,
    ].filter(Boolean).join(' · ')
    el.viewerSubtitle.classList.remove('hidden')
    el.viewerContent.innerHTML = renderMarkdown(openNote.notes_content)
    setEditing(false)
    openModal(el.viewer)
  }

  function setEditing(editing) {
    el.viewerContent.classList.toggle('hidden', editing)
    el.viewerEditor.classList.toggle('hidden', !editing)
    el.editNoteBtn.classList.toggle('hidden', editing)
    el.saveNoteChangesBtn.classList.toggle('hidden', !editing)
    el.cancelNoteEditBtn.classList.toggle('hidden', !editing)
    el.viewerStatus.textContent = ''
    if (editing) {
      el.viewerEditor.value = openNote.notes_content
      el.viewerEditor.focus()
    }
  }

  el.editNoteBtn.addEventListener('click', () => setEditing(true))
  el.cancelNoteEditBtn.addEventListener('click', () => setEditing(false))
  el.closeViewerBtn.addEventListener('click', () => closeModal(el.viewer))

  el.saveNoteChangesBtn.addEventListener('click', async () => {
    const content = el.viewerEditor.value
    el.saveNoteChangesBtn.disabled = true
    el.viewerStatus.textContent = 'Saving…'
    try {
      await api.updateNote(openNote.id, { content })
      openNote.notes_content = content
      el.viewerContent.innerHTML = renderMarkdown(content)
      setEditing(false)
      el.viewerStatus.textContent = 'Saved.'
      invalidateShelf()
      paintNotes()
    } catch (error) {
      el.viewerStatus.textContent = error.message
    } finally {
      el.saveNoteChangesBtn.disabled = false
    }
  })

  el.deleteNoteBtn.addEventListener('click', async () => {
    if (!openNote) return
    // Two clicks, not a confirm dialog: the button says what it will do and
    // then asks for it again. A guide can be a lot of work to lose.
    if (el.deleteNoteBtn.dataset.armed !== 'yes') {
      el.deleteNoteBtn.dataset.armed = 'yes'
      el.deleteNoteBtn.textContent = 'Really delete?'
      return
    }
    try {
      await api.deleteNote(openNote.id)
      notes = notes.filter((n) => n.id !== openNote.id)
      selected.delete(openNote.id)
      invalidateShelf()
      closeModal(el.viewer)
      paintNotes()
    } catch (error) {
      el.viewerStatus.textContent = error.message
    }
  })

  // --------------------------------------------------------- bulk deletes --

  for (const [button, run, label] of [
    [el.deleteAllCluesBtn, () => api.deleteAllClues(shelf), 'clues'],
    [el.deleteAllFlashcardsBtn, () => api.deleteAllFlashcards(shelf), 'flashcards'],
  ]) {
    button.addEventListener('click', async () => {
      if (button.dataset.armed !== 'yes') {
        button.dataset.armed = 'yes'
        button.textContent = `Really delete all ${label}?`
        return
      }
      button.disabled = true
      try {
        await run()
        invalidateShelf()
        await openShelf(shelf)
      } finally {
        button.disabled = false
        delete button.dataset.armed
      }
    })
  }

  // ------------------------------------------------------- manual cards ----

  el.addFlashcardBtn.addEventListener('click', async () => {
    // Prompt rather than a dialog of its own: the desktop generates cards with
    // the AI and only offers "+" as an escape hatch, and until the server-side
    // key exists that escape hatch is the whole feature. A real editor here
    // would be building UI for a path that is about to change shape.
    const term = window.prompt('Front of the card (the term):')
    if (!term?.trim()) return
    const definition = window.prompt('Back of the card (the definition):')
    if (!definition?.trim()) return

    try {
      await api.saveFlashcards({
        category: shelf,
        flashcards: [{ term: term.trim(), definition: definition.trim() }],
      })
      invalidateShelf()
      await openShelf(shelf)
    } catch (error) {
      window.alert(error.message)
    }
  })

  // -------------------------------------------------------------- helpers --

  function show(which) {
    el.hubScreen.classList.toggle('hidden', which !== 'hubScreen')
    el.detailScreen.classList.toggle('hidden', which !== 'detailScreen')
  }

  function openModal(modal) {
    modal.classList.remove('hidden')
    modal.classList.add('flex')
  }

  function closeModal(modal) {
    modal.classList.add('hidden')
    modal.classList.remove('flex')
    // Re-arm the destructive buttons, so a modal reopened later does not still
    // be one click from deleting something.
    delete el.deleteNoteBtn.dataset.armed
    el.deleteNoteBtn.textContent = 'Delete'
  }

  for (const modal of [el.viewer, el.nameModal]) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal)
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    for (const modal of [el.viewer, el.nameModal]) {
      if (!modal.classList.contains('hidden')) closeModal(modal)
    }
  })

  for (const button of document.querySelectorAll('[data-notebook-back]')) {
    button.addEventListener('click', () => {
      if (button.dataset.notebookBack === 'hub') openHub()
      else onBack()
    })
  }

  // For main.js's own "Save Highlight" button on the Reader screen: that
  // writes a clue into whichever shelf the question resolves to, server-side,
  // without this module ever being told which one. Clearing everything is the
  // one dependable fix -- see the `shelfCache` comment above.
  return { openHub, resetShelfCache: () => shelfCache.clear() }
}
