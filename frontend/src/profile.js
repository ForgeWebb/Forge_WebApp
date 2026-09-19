/**
 * The profile page: the analysis panels, drawn.
 *
 * The desktop renders each of these as a matplotlib PNG on the server and
 * ships base64 inside a JSON body. The API here returns numbers and a written
 * finding instead (see web/api/panels.py), so the drawing is this file's job.
 *
 * Charts are hand-built SVG rather than a charting library. The shapes are
 * simple (bars, a grid, a pair of lines), and inline SVG inherits the page's
 * own colours instead of needing a theme adapter to be told about them.
 *
 * **Colour is validated, not eyeballed.** Blue/red is the one hue pair in
 * this app's palette that clears every colourblind-safety check (adjacent and
 * all-pairs) against the `#2c2321` chart surface — run
 * `node scripts/validate_palette.js "#3e8ed0,#d9534f" --mode dark --surface
 * "#2c2321" --pairs all` from the dataviz skill to see it pass. The old
 * green/red pairing this file used to draw negs-vs-hits with (and desktop's
 * matplotlib charts still do, in Outcome Split and Buzz Spread) measures
 * ΔE 4.3 under deuteranopia — a red-green colourblind reader cannot tell
 * "power" from "neg" apart in that chart at all. Every panel below is blue
 * (good / converted) vs. red (bad / missed), full stop; where a third class
 * is unavoidable (Outcome Split's power/ten/neg), it is drawn as two steps of
 * blue plus red rather than a third hue, because no hue combination with red
 * in this app's palette clears the all-pairs floor at three slots.
 *
 * **The minimum-sample gate is drawn, not just carried, on the panels that
 * have one.** Those mark buckets below their gate as hatched and dimmed, and
 * say so in a legend — the server already refuses to compare them or reach a
 * verdict off them, so showing them identically to the solid ones would put
 * that judgement back in the reader's hands after the API had deliberately
 * taken it out.
 *
 * **Every bar, cell and point carries its own hover tooltip.** An inline SVG
 * chart is interactive by construction — see the dataviz skill's
 * `interaction.md` — so this is the default here, not an add-on. Tooltips
 * enhance; they never gate. Every number a tooltip shows also sits in the
 * table view underneath, reachable with no pointer at all.
 */

import { api } from './api.js'

const NS = 'http://www.w3.org/2000/svg'

// The validated pair (see the module docstring): blue for "good", red for
// "bad", nothing else competing for identity. INK/MUTED/GRID are chart
// chrome (text, gridlines, reference lines) — never data-identity colour.
const INK = '#efe0db'
const MUTED = '#baa7a1'
const GRID = '#584741'
const BLUE = '#3e8ed0'
const BLUE_LIGHT = '#7db3e0' // a second step of the same hue -- sequential, not a second identity
const RED = '#d9534f'
const SURFACE = '#2c2321'

// ------------------------------------------------------------ svg helpers --

function tag(name, attrs = {}, children = []) {
  const node = document.createElementNS(NS, name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function text(x, y, value, attrs = {}) {
  return tag('text', {
    x, y, fill: MUTED, 'font-size': 11, 'font-family': 'inherit', ...attrs,
  }, String(value))
}

/** A chart canvas that scales to its container rather than to a pixel size. */
function canvas(width, height) {
  const svg = tag('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    role: 'img',
    style: 'display:block;overflow:visible',
  })
  // The hatch every gated panel uses for a bucket below its sample floor.
  svg.append(tag('defs', {}, [
    tag('pattern', {
      id: 'thin', width: 6, height: 6, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    }, [tag('rect', { width: 3, height: 6, fill: GRID, opacity: 0.9 })]),
  ]))
  return svg
}

/** Below-gate buckets are hatched; solid ones take their real colour. */
function fillFor(reliable, colour) {
  return reliable ? colour : 'url(#thin)'
}

function legend(minSample, unit) {
  const note = document.createElement('p')
  note.className = 'mt-3 text-xs text-text-muted'
  note.textContent =
    `Hatched bars have fewer than ${minSample} ${unit} — shown, but never ` +
    `compared or used to reach the finding on the left.`
  return note
}

/** A colour-key legend: a short line/swatch beside a label, never a filled
 *  box (see marks-and-anatomy.md — a box at this density is data-weight ink
 *  doing a label's job). Skipped entirely for a single series; the chart's
 *  own title already says what is plotted. */
function seriesLegend(entries) {
  const wrap = document.createElement('div')
  wrap.className = 'mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted'
  for (const { colour, label } of entries) {
    const item = document.createElement('span')
    item.className = 'inline-flex items-center gap-1.5'
    const swatch = document.createElement('span')
    swatch.className = 'inline-block h-2 w-3 rounded-sm'
    swatch.style.background = colour
    item.append(swatch, document.createTextNode(label))
    wrap.append(item)
  }
  return wrap
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function emptyNote(message) {
  const p = document.createElement('p')
  p.className = 'text-sm text-text-muted'
  p.textContent = message
  return p
}

/** A plain table, for the numbers behind whichever chart is on screen --
 *  every value a tooltip carries also lives here, reachable with no pointer
 *  (see interaction.md: "a tooltip enhances, it never gates"). */
function table(headers, rows) {
  const wrap = document.createElement('div')
  wrap.className = 'mt-4 overflow-x-auto'
  const t = document.createElement('table')
  t.className = 'w-full text-left text-sm'
  t.innerHTML =
    `<thead><tr class="border-b border-[#584741] text-xs text-text-muted">` +
    headers.map((h) => `<th class="py-1 pr-3 font-semibold">${h}</th>`).join('') +
    `</tr></thead><tbody>` +
    rows.map((row) =>
      `<tr class="border-b border-[#3e322e]">` +
      row.map((cell) => `<td class="py-1 pr-3">${cell}</td>`).join('') +
      `</tr>`).join('') +
    `</tbody>`
  wrap.append(t)
  return wrap
}

// ------------------------------------------------------------ hover layer --

/** One tooltip element, reused by every chart on the page rather than one
 *  per chart -- there is only ever one pointer, so there only needs to be
 *  one floating readout, created lazily and repositioned on every hover. */
let sharedTooltip = null
function tooltipEl() {
  if (sharedTooltip) return sharedTooltip
  sharedTooltip = document.createElement('div')
  sharedTooltip.className =
    'pointer-events-none fixed z-50 hidden max-w-xs rounded-lg border border-[#584741] ' +
    'bg-[#1d1816] px-2.5 py-1.5 text-xs shadow-lg'
  document.body.append(sharedTooltip)
  return sharedTooltip
}

/** Wires a hover/focus tooltip onto one mark. `render(container)` builds the
 *  tooltip body into `container` (values as Strong text nodes, never
 *  innerHTML -- see interaction.md's rule that labels are untrusted data).
 *  The mark itself gets a lift (brighter fill) so hovering visibly responds,
 *  and the hit target is the mark's own bounding box plus a few px, which
 *  for these bar/cell charts already comfortably clears the 24px minimum. */
function attachTooltip(mark, render, { restoreFill } = {}) {
  const tip = tooltipEl()
  const baseFill = mark.getAttribute('fill')
  mark.style.cursor = 'pointer'
  mark.tabIndex = 0

  const show = (clientX, clientY) => {
    tip.innerHTML = ''
    render(tip)
    tip.classList.remove('hidden')
    const rect = tip.getBoundingClientRect()
    tip.style.left = `${Math.min(clientX + 12, window.innerWidth - rect.width - 8)}px`
    tip.style.top = `${Math.max(clientY - rect.height - 12, 8)}px`
    if (baseFill && baseFill !== 'url(#thin)') {
      mark.setAttribute('fill', restoreFill ?? BLUE_LIGHT)
    }
  }
  const hide = () => {
    tip.classList.add('hidden')
    if (baseFill) mark.setAttribute('fill', baseFill)
  }

  mark.addEventListener('pointermove', (e) => show(e.clientX, e.clientY))
  mark.addEventListener('pointerenter', (e) => show(e.clientX, e.clientY))
  mark.addEventListener('pointerleave', hide)
  mark.addEventListener('focus', () => {
    const box = mark.getBoundingClientRect()
    show(box.left + box.width / 2, box.top)
  })
  mark.addEventListener('blur', hide)
}

/** The tooltip body shared by every chart: a bold value line, then muted
 *  detail lines -- "values lead, labels follow" (interaction.md). */
function tooltipBody(container, title, rows) {
  const t = document.createElement('div')
  t.className = 'font-semibold text-text-light'
  t.textContent = title
  container.append(t)
  for (const row of rows) {
    const p = document.createElement('div')
    p.className = 'text-text-muted'
    p.textContent = row
    container.append(p)
  }
}

// ------------------------------------------------------------ view toggle --

/** The Value/Spread/Table-style tab row desktop's own Settings panels use.
 *  Pure presentation -- the caller owns which view is active and re-renders
 *  on change; this just paints buttons and reports clicks. Lives in its own
 *  row alongside the main panel picker (statSubPicker / recordsDetailSubPicker),
 *  not inside the chart box, so it reads as "which view of this panel"
 *  rather than a second, disconnected control floating below the title. */
function toggleRow(views, activeKey, onSelect) {
  const group = document.createElement('div')
  group.className = 'inline-flex rounded-full bg-tertiary-dark p-0.5 text-xs font-bold'
  for (const view of views) {
    const button = document.createElement('button')
    button.textContent = view.label
    button.title = view.title ?? ''
    button.className = 'rounded-full px-3 py-1 ' +
      (view.key === activeKey ? 'bg-[#efe0db] text-[#1d1816]' : 'text-text-muted')
    button.addEventListener('click', () => onSelect(view.key))
    group.append(button)
  }
  return group
}

// -------------------------------------------------------- where you buzz --

/** Points per buzz, by quarter of the tossup.
 *
 * Bars run from a zero line rather than from the left edge, because the whole
 * point of the panel is that a buzz point can be worth *negative* points and a
 * bar chart with an implicit zero at the axis hides exactly that.
 */
function drawBuzzpointsValue(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame

  const width = 560
  const rowH = 46
  const barH = 22
  const height = data.bands.length * rowH + 24
  const svg = canvas(width, height)

  const labelW = 130
  const plotW = width - labelW - 60
  const values = data.bands.map((b) => b.perBuzz ?? 0)
  const span = Math.max(15, ...values.map(Math.abs))
  const zero = labelW + plotW / 2
  const scale = (plotW / 2) / span

  svg.append(text(width - 4, 12, 'Points per buzz',
    { 'text-anchor': 'end', 'font-size': 10, 'font-weight': 600, fill: INK }))
  svg.append(tag('line', {
    x1: zero, y1: 20, x2: zero, y2: height - 6, stroke: GRID, 'stroke-width': 1,
  }))
  svg.append(text(zero, height - 2, '0', { 'text-anchor': 'middle' }))

  data.bands.forEach((band, i) => {
    const y = i * rowH + 20
    svg.append(text(labelW - 8, y + barH / 2 + 4, band.label,
      { 'text-anchor': 'end', fill: INK, 'font-size': 12 }))

    if (!band.buzzes) {
      svg.append(text(zero + 8, y + barH / 2 + 4, 'no buzzes'))
      return
    }
    const value = band.perBuzz
    const length = Math.abs(value) * scale
    const colour = value >= 0 ? BLUE : RED
    const bar = tag('rect', {
      x: value >= 0 ? zero : zero - length,
      y, width: Math.max(length, 2), height: barH, rx: 4,
      fill: fillFor(band.reliable, colour),
    })
    svg.append(bar)
    attachTooltip(bar, (tip) => tooltipBody(tip, band.label, [
      `${value > 0 ? '+' : ''}${value.toFixed(1)} points per buzz`,
      `${band.buzzes} buzz${band.buzzes === 1 ? '' : 'es'} · ${band.conversion}% converted`,
      `${band.powers} power / ${band.tens} ten / ${band.negs} neg`,
      ...(band.reliable ? [] : [`Fewer than ${data.minSample} buzzes — not compared`]),
    ]), { restoreFill: value >= 0 ? BLUE_LIGHT : '#e57a76' })

    svg.append(text(
      value >= 0 ? zero + length + 6 : zero - length - 6, y + barH / 2 + 4,
      `${value > 0 ? '+' : ''}${value.toFixed(1)}`,
      { 'text-anchor': value >= 0 ? 'start' : 'end', fill: INK, 'font-size': 12 }))
  })

  frame.append(svg, legend(data.minSample, 'buzzes'))
  return frame
}

function drawBuzzpointsTable(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame
  frame.append(table(
    ['Buzz point', 'Buzzes', 'P / T / N', 'Points', 'Per buzz', 'Converted'],
    data.bands.map((b) => [
      b.label, b.buzzes, `${b.powers} / ${b.tens} / ${b.negs}`, b.points,
      b.perBuzz === null ? '—' : `${b.perBuzz > 0 ? '+' : ''}${b.perBuzz.toFixed(1)}`,
      b.conversion === null ? '—' : `${b.conversion}%`,
    ])))
  return frame
}

// --------------------------------------------------------------- ceiling --

/** Accuracy at each difficulty, with the 50% line the ceiling is defined by.
 *
 * One hue throughout -- bars do not change colour by tier. The wall (nothing
 * converts past here) is a translucent red wash behind the bars, and the
 * ceiling itself is called out with a marker line, so a *zone* and a *single
 * value* each get their own kind of emphasis instead of a third bar colour
 * competing with blue/red everywhere else in this app.
 */
function drawCeiling(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame

  const width = 560
  const height = 270
  const svg = canvas(width, height)
  const left = 34
  const bottom = height - 50
  const top = 22
  const plotW = width - left - 12
  const plotH = bottom - top
  const barW = Math.min(46, plotW / data.levels.length - 8)

  if (data.wall !== null) {
    const wallIdx = data.levels.findIndex((l) => l.difficulty >= data.wall)
    if (wallIdx >= 0) {
      const x = left + wallIdx * (plotW / data.levels.length)
      svg.append(tag('rect', {
        x, y: top, width: width - 12 - x, height: plotH, fill: RED, opacity: 0.10,
      }))
    }
  }

  // Gridlines at 0 / 50 / 100, solid hairlines -- a dashed grid reads as a
  // projection or a threshold, which is exactly what the 50% line below
  // means, so the grid itself stays plain and lets that line be the one
  // dashed thing on the chart.
  for (const pct of [0, 50, 100]) {
    const y = bottom - (pct / 100) * plotH
    svg.append(tag('line', {
      x1: left, y1: y, x2: width - 12, y2: y, stroke: GRID, 'stroke-width': 1,
    }))
    svg.append(text(left - 6, y + 4, `${pct}%`, { 'text-anchor': 'end', 'font-size': 10 }))
  }
  const halfY = bottom - 0.5 * plotH
  svg.append(tag('line', {
    x1: left, y1: halfY, x2: width - 12, y2: halfY, stroke: MUTED,
    'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.7,
  }))

  data.levels.forEach((level, i) => {
    const x = left + 8 + i * (plotW / data.levels.length)
    const h = (level.accuracy / 100) * plotH
    const isCeiling = level.difficulty === data.ceiling
    const bar = tag('rect', {
      x, y: bottom - h, width: barW, height: Math.max(h, 1), rx: 4,
      fill: fillFor(level.reliable, BLUE),
      stroke: isCeiling ? INK : 'none', 'stroke-width': isCeiling ? 2 : 0,
    })
    svg.append(bar)
    attachTooltip(bar, (tip) => tooltipBody(tip, `${level.tier ?? `Difficulty ${level.difficulty}`}`, [
      `${level.accuracy}% converted (${level.correct} of ${level.attempts})`,
      `${level.perQuestion > 0 ? '+' : ''}${level.perQuestion.toFixed(1)} points per question`,
      ...(isCeiling ? ['Your ceiling — the hardest level still above 50%'] : []),
      ...(level.reliable ? [] : [`Fewer than ${data.minSample} answers — not compared`]),
    ]))

    svg.append(text(x + barW / 2, bottom - h - 5, `${level.accuracy}%`,
      { 'text-anchor': 'middle', fill: INK, 'font-size': 10 }))
    svg.append(text(x + barW / 2, bottom + 14, level.difficulty,
      { 'text-anchor': 'middle', fill: INK, 'font-size': 11 }))
    if (level.tier) {
      svg.append(text(x + barW / 2, bottom + 28, level.tier,
        { 'text-anchor': 'middle', 'font-size': 8 }))
    }
  })

  frame.append(svg, legend(data.minSample, 'answers'))
  return frame
}

function drawCeilingTable(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame
  frame.append(table(
    ['Difficulty', 'Tier', 'Answers', 'Correct', 'Accuracy', 'Per question'],
    data.levels.map((l) => [
      l.difficulty, l.tier ?? '—', l.attempts, l.correct, `${l.accuracy}%`,
      `${l.perQuestion > 0 ? '+' : ''}${l.perQuestion.toFixed(1)}`,
    ])))
  return frame
}

// ----------------------------------------------------------- neg autopsy --

/** Neg rate as a difficulty by buzz-point grid.
 *
 * A heatmap of *rates*, never counts, in one sequential hue -- red, deepening
 * with rate. Raw neg counts follow wherever you happen to buzz most, so 12
 * negs out of 12 and 12 out of 40 look identical in a tally and are nothing
 * alike, which is the mistake this panel exists to stop the outcome split
 * making.
 */
function drawNegAutopsyGrid(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame

  const quarters = data.byQuarter.map((q) => q.label)
  const difficulties = data.byDifficulty.map((d) => d.difficulty)
  const cell = 54
  const left = 108
  const top = 30
  const width = left + difficulties.length * cell + 16
  const height = top + quarters.length * cell + 40
  const svg = canvas(Math.max(width, 360), height)

  difficulties.forEach((d, x) => {
    svg.append(text(left + x * cell + cell / 2, top - 10, d,
      { 'text-anchor': 'middle', fill: INK, 'font-size': 11 }))
  })

  const byCell = new Map(data.grid.map((g) => [`${g.difficulty}|${g.quarter}`, g]))

  quarters.forEach((q, y) => {
    svg.append(text(left - 8, top + y * cell + cell / 2 + 4, q,
      { 'text-anchor': 'end', fill: INK, 'font-size': 11 }))

    difficulties.forEach((d, x) => {
      const found = byCell.get(`${d}|${q}`)
      const px = left + x * cell
      const py = top + y * cell
      if (!found) {
        svg.append(tag('rect', {
          x: px + 2, y: py + 2, width: cell - 4, height: cell - 4, rx: 4,
          fill: GRID, opacity: 0.25,
        }))
        return
      }
      const cellRect = tag('rect', {
        x: px + 2, y: py + 2, width: cell - 4, height: cell - 4, rx: 4,
        fill: found.reliable ? RED : 'url(#thin)',
        opacity: found.reliable ? 0.20 + 0.75 * (found.negRate / 100) : 1,
      })
      svg.append(cellRect)
      attachTooltip(cellRect, (tip) => tooltipBody(tip, `${d} · ${q}`, [
        `${found.negRate}% neg rate`,
        `${found.negs} of ${found.buzzes} buzzes`,
        ...(found.reliable ? [] : [`Fewer than ${data.minSample} buzzes — not compared`]),
      ]))
      svg.append(text(px + cell / 2, py + cell / 2, `${found.negRate}%`,
        { 'text-anchor': 'middle', fill: INK, 'font-size': 12, 'font-weight': 700 }))
      svg.append(text(px + cell / 2, py + cell / 2 + 14, `${found.negs}/${found.buzzes}`,
        { 'text-anchor': 'middle', 'font-size': 9 }))
    })
  })

  svg.append(text(left, height - 10, 'Difficulty across, buzz point down · darker is a higher neg rate',
    { 'font-size': 10 }))

  frame.append(svg, legend(data.minSample, 'buzzes'))
  return frame
}

function drawNegAutopsyBreakdown(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame
  frame.append(table(
    ['Buzz point', 'Buzzes', 'Negs', 'Neg rate'],
    data.byQuarter.map((q) => [
      q.label, q.buzzes, q.negs, q.negRate === null ? '—' : `${q.negRate}%`])))
  frame.append(table(
    ['Difficulty', 'Buzzes', 'Negs', 'Neg rate'],
    data.byDifficulty.map((d) => [
      d.difficulty, d.buzzes, d.negs, d.negRate === null ? '—' : `${d.negRate}%`])))
  return frame
}

// ------------------------------------------------------------- retention --

/** SM-2 easiness per subject, drawn against the 2.5 starting line.
 *
 * The line is what makes the chart readable at all: easiness only means
 * anything relative to where every question starts, so "below the line" is the
 * finding and an absolute height is not.
 */
function drawRetention(data) {
  const frame = document.createDocumentFragment()
  if (!data.subjects.length) return frame.append(emptyNote(data.summary)), frame

  const width = 560
  const rowH = 34
  const barH = 20
  const height = data.subjects.length * rowH + 30
  const svg = canvas(width, height)

  const labelW = 150
  const plotW = width - labelW - 70
  // 1.3 is SM-2's floor and easiness rarely climbs past 3.0, so the axis is
  // fixed to that range instead of to the data -- a subject at 2.4 should not
  // fill the chart just because it happens to be the lowest one today.
  const lo = 1.3
  const hi = 3.0
  const at = (ef) => labelW + ((Math.min(hi, Math.max(lo, ef)) - lo) / (hi - lo)) * plotW

  const start = at(2.5)
  svg.append(tag('line', {
    x1: start, y1: 4, x2: start, y2: height - 20, stroke: MUTED,
    'stroke-width': 1, 'stroke-dasharray': '4 3',
  }))
  svg.append(text(start, height - 6, '2.5 — where every question starts',
    { 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }))

  data.subjects.forEach((subject, i) => {
    const y = i * rowH + 6
    svg.append(text(labelW - 8, y + barH / 2 + 4, subject.category,
      { 'text-anchor': 'end', fill: INK, 'font-size': 12 }))
    const x = at(subject.ef)
    const below = subject.ef < 2.5
    const bar = tag('rect', {
      x: below ? x : start, y, width: Math.max(Math.abs(x - start), 2), height: barH, rx: 4,
      fill: fillFor(subject.reliable, below ? RED : BLUE),
    })
    svg.append(bar)
    attachTooltip(bar, (tip) => tooltipBody(tip, subject.category, [
      `Easiness ${subject.ef.toFixed(2)} (starts at 2.50)`,
      `${subject.reviewed} reviewed · ${subject.attempts} attempts, ${subject.correct} correct`,
      `Comes back in ${subject.intervalDays} day${subject.intervalDays === 1 ? '' : 's'}`,
      ...(subject.reliable ? [] : [`Fewer than ${data.minSample} reviewed — not compared`]),
    ]))
    svg.append(text(width - 60, y + barH / 2 + 4, subject.ef.toFixed(2),
      { fill: INK, 'font-size': 12 }))
  })

  frame.append(svg, legend(data.minSample, 'reviewed questions'))
  frame.append(table(
    ['Subject', 'Reviewed', 'Easiness', 'Attempts', 'Correct', 'Avg interval'],
    data.subjects.map((s) => [
      s.category, s.reviewed, s.ef.toFixed(2), s.attempts, s.correct,
      `${s.intervalDays} d`])))
  return frame
}

// -------------------------------------------------------- knowledge depth --

/** Per-cluster skill within each subject played, weakest cluster first.
 *
 * One hue, light-to-dark by skill -- sequential encoding for a continuous
 * 0-10 number, not three discrete "tiers" fighting for identity. Every other
 * panel compares *across* subjects; this is the only one that looks inside
 * one, so the axis is fixed 0-10 (see web/api/adaptive.py's UserModel) the
 * same way Retention's is fixed to easiness.
 */
function drawKnowledgeDepth(data) {
  const frame = document.createDocumentFragment()
  if (!data.hasData) return frame.append(emptyNote(data.evaluation)), frame

  if (!data.namedByAi) {
    const note = document.createElement('p')
    note.className = 'mb-3 text-xs text-text-muted'
    // Names are generated in the background after the first visit, so
    // this note is what the first look sees; there is nothing for the
    // player to do about it any more (the website's AI runs on the
    // operator's key), so it no longer tells them to.
    note.textContent = 'Topic names below are drawn from example answers, ' +
      'not generated yet — check back after a moment for real topic names.'
    frame.append(note)
  }

  const width = 620
  const labelW = 190
  const rowH = 26
  const headerH = 22
  const totalRows = data.subjects.reduce((n, s) => n + s.clusters.length, 0)
  const height = data.subjects.length * headerH + totalRows * rowH + 10
  const svg = canvas(width, height)

  const plotW = width - labelW - 60
  const lo = 0, hi = 10
  const at = (skill) => labelW + (Math.min(hi, Math.max(lo, skill)) / hi) * plotW
  // Lightness carries the value: thin (below 4) reads pale, strong (7+) reads
  // full-strength blue. Never a hue change -- this is magnitude, one series.
  const colourFor = (skill) => {
    const t = Math.min(1, Math.max(0, skill / 10))
    return `color-mix(in oklab, ${BLUE_LIGHT} ${(1 - t) * 100}%, #1d5a94 ${t * 100}%)`
  }

  let y = 4
  for (const subject of data.subjects) {
    svg.append(text(4, y + 14, `${subject.subcategory} — average ${subject.average}`,
      { fill: INK, 'font-size': 12, 'font-weight': 'bold' }))
    y += headerH

    for (const cluster of subject.clusters) {
      const x = at(cluster.skill)
      const bar = tag('rect', {
        x: labelW, y, width: Math.max(x - labelW, 2), height: rowH - 8, rx: 4,
        fill: colourFor(cluster.skill),
      })
      svg.append(bar)
      attachTooltip(bar, (tip) => tooltipBody(tip, cluster.label, [
        `Skill ${cluster.skill.toFixed(1)} of 10`,
        subject.subcategory,
      ]), { restoreFill: colourFor(cluster.skill) })
      svg.append(text(labelW - 8, y + (rowH - 8) / 2 + 4, cluster.label,
        { 'text-anchor': 'end', fill: MUTED, 'font-size': 11 }))
      svg.append(text(x + 6, y + (rowH - 8) / 2 + 4, cluster.skill.toFixed(1),
        { fill: INK, 'font-size': 11 }))
      y += rowH
    }
  }

  frame.append(svg)
  frame.append(table(
    ['Subject', 'Topic', 'Skill'],
    data.subjects.flatMap((s) => s.clusters.map((c) =>
      [s.subcategory, escapeHtmlLocal(c.label), c.skill.toFixed(1)]))))
  return frame
}

/** The one place this file puts free text (an AI-generated topic name, or a
 *  fallback drawn from real answerlines) into innerHTML rather than a text
 *  node -- table() below builds rows as HTML strings, same as every other
 *  panel's table, but those only ever carry category names and numbers this
 *  server already controls. A cluster label is the first value in this file
 *  that either came out of a model or is assembled from question data at
 *  request time, so it gets escaped on the way in rather than trusted. */
function escapeHtmlLocal(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// ------------------------------------------------------------ outcome split --

/** How every tossup you've buzzed on has gone: converted (power or ten) vs.
 *  negged. A single two-segment bar rather than the desktop's pie -- see
 *  anti-patterns.md, part-to-whole reads fine as a pie for two or three
 *  *evenly spaced* hues, but power/ten/neg has no CVD-safe third hue in this
 *  app's palette (checked: no combination of blue/red plus a third categorical
 *  slot clears the all-pairs floor here), so power vs. ten is drawn as a
 *  direct label inside the converted segment instead of a competing colour.
 */
function drawOutcomeSplit(data) {
  const frame = document.createDocumentFragment()
  const { powers, tens, negs } = data
  const converted = powers + tens
  const total = converted + negs
  if (!total) return frame.append(emptyNote('No buzzes recorded yet.')), frame

  const width = 560
  const height = 92
  const svg = canvas(width, height)
  const barH = 40
  const y = 28
  const convertedW = (converted / total) * width
  const negW = width - convertedW

  if (converted > 0) {
    const seg = tag('rect', { x: 0, y, width: Math.max(convertedW, 2), height: barH, fill: BLUE })
    svg.append(seg)
    attachTooltip(seg, (tip) => tooltipBody(tip, 'Converted', [
      `${converted} of ${total} buzzes (${((converted / total) * 100).toFixed(1)}%)`,
      `${powers} power, ${tens} ten`,
    ]), { restoreFill: BLUE_LIGHT })
    if (convertedW > 70) {
      svg.append(text(convertedW / 2, y + barH / 2 - 3, `${((converted / total) * 100).toFixed(0)}% converted`,
        { 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 12, 'font-weight': 700 }))
      svg.append(text(convertedW / 2, y + barH / 2 + 12, `${powers} power · ${tens} ten`,
        { 'text-anchor': 'middle', fill: '#e8f1fb', 'font-size': 10 }))
    }
  }
  if (negs > 0) {
    const seg = tag('rect', { x: convertedW, y, width: Math.max(negW, 2), height: barH, fill: RED })
    svg.append(seg)
    attachTooltip(seg, (tip) => tooltipBody(tip, 'Negged', [
      `${negs} of ${total} buzzes (${((negs / total) * 100).toFixed(1)}%)`,
    ]), { restoreFill: '#e57a76' })
    if (negW > 60) {
      svg.append(text(convertedW + negW / 2, y + barH / 2 + 4, `${((negs / total) * 100).toFixed(0)}% neg`,
        { 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 12, 'font-weight': 700 }))
    }
  }

  frame.append(svg, seriesLegend([
    { colour: BLUE, label: 'Converted (power or ten)' },
    { colour: RED, label: 'Neg' },
  ]))
  frame.append(table(
    ['Outcome', 'Count', 'Share'],
    [
      ['Power', powers, `${total ? ((powers / total) * 100).toFixed(1) : '0.0'}%`],
      ['Ten', tens, `${total ? ((tens / total) * 100).toFixed(1) : '0.0'}%`],
      ['Neg', negs, `${total ? ((negs / total) * 100).toFixed(1) : '0.0'}%`],
    ]))
  return frame
}

// ---------------------------------------------------- points by category --

/** Total points per category, every category compared at once.
 *
 * The one cross-category panel -- see web/api/routes/stats.py's own note on
 * `/points-by-category` -- so unlike every other panel here it takes no
 * category filter and, like Retention, isn't offered under a session filter
 * either (a session is one sitting; "which subject is worth my time" is an
 * account-wide question).
 */
function drawPointsByCategory(data) {
  const frame = document.createDocumentFragment()
  if (!data.categories.length) return frame.append(emptyNote('No categories played yet.')), frame

  const width = 560
  const rowH = 30
  const barH = 18
  const height = data.categories.length * rowH + 16
  const svg = canvas(width, height)

  const labelW = 160
  const plotW = width - labelW - 70
  const span = Math.max(15, ...data.categories.map((c) => Math.abs(c.points)))
  const zero = labelW + plotW / 2
  const scale = (plotW / 2) / span

  svg.append(tag('line', {
    x1: zero, y1: 4, x2: zero, y2: height - 10, stroke: GRID, 'stroke-width': 1,
  }))

  data.categories.forEach((c, i) => {
    const y = i * rowH + 4
    svg.append(text(labelW - 8, y + barH / 2 + 4, c.category,
      { 'text-anchor': 'end', fill: INK, 'font-size': 12 }))
    const length = Math.abs(c.points) * scale
    const colour = c.points >= 0 ? BLUE : RED
    const bar = tag('rect', {
      x: c.points >= 0 ? zero : zero - length,
      y, width: Math.max(length, 2), height: barH, rx: 4, fill: colour,
    })
    svg.append(bar)
    attachTooltip(bar, (tip) => tooltipBody(tip, c.category, [
      `${c.points > 0 ? '+' : ''}${c.points} points`,
    ]), { restoreFill: c.points >= 0 ? BLUE_LIGHT : '#e57a76' })
    svg.append(text(
      c.points >= 0 ? zero + length + 6 : zero - length - 6, y + barH / 2 + 4,
      `${c.points > 0 ? '+' : ''}${c.points}`,
      { 'text-anchor': c.points >= 0 ? 'start' : 'end', fill: INK, 'font-size': 12 }))
  })

  frame.append(svg)
  frame.append(table(['Category', 'Points'], data.categories.map((c) => [c.category, c.points])))
  return frame
}

// ---------------------------------------------------------- think then buzz --

/** Accuracy buzzing early to think it through vs. buzzing on reflex.
 *
 * The server sends two pre-formatted strings ("62.5% (5/8)") rather than raw
 * numbers -- `panels.aggressive_play` is ported verbatim from the desktop's
 * own wording, evaluation included, so the percentage is parsed back out of
 * it for the bar rather than recomputed here and risking the two disagreeing.
 * One hue at two strengths (strong blue >= 65%, pale blue >= 50%) plus red
 * below half -- magnitude against a threshold, not three competing series.
 */
function drawAggressivePlay(data) {
  const frame = document.createDocumentFragment()
  const thinkingPct = parseFloat(data.thinkingBuzzAccuracy)
  const reflexPct = parseFloat(data.reflexBuzzAccuracy)
  if (Number.isNaN(thinkingPct) && Number.isNaN(reflexPct)) {
    return frame.append(emptyNote(data.evaluation)), frame
  }

  const width = 480
  const rowH = 54
  const barH = 24
  const height = rowH * 2 + 16
  const svg = canvas(width, height)
  const labelW = 190
  const plotW = width - labelW - 60

  const rows = [
    { label: `Buzz after ${(data.thresholdMs / 1000).toFixed(1)}s (thinking)`, pct: thinkingPct, sub: data.thinkingBuzzAccuracy },
    { label: 'Buzz before that (reflex)', pct: reflexPct, sub: data.reflexBuzzAccuracy },
  ]

  rows.forEach((row, i) => {
    const y = i * rowH + 8
    svg.append(text(labelW - 8, y + barH / 2 + 4, row.label,
      { 'text-anchor': 'end', fill: INK, 'font-size': 12 }))
    if (Number.isNaN(row.pct)) {
      svg.append(text(labelW + 8, y + barH / 2 + 4, 'no data'))
      return
    }
    const barW = (row.pct / 100) * plotW
    const colour = row.pct >= 65 ? BLUE : row.pct >= 50 ? BLUE_LIGHT : RED
    const bar = tag('rect', {
      x: labelW, y, width: Math.max(barW, 2), height: barH, rx: 4, fill: colour,
    })
    svg.append(bar)
    attachTooltip(bar, (tip) => tooltipBody(tip, row.label, [`Accuracy ${row.sub}`]))
    svg.append(text(labelW + barW + 6, y + barH / 2 + 4, row.sub, { fill: INK, 'font-size': 12 }))
  })

  frame.append(svg)
  return frame
}

// -------------------------------------------------------------- buzz spread --

/** A 10-bin histogram of exactly where in the tossup a buzz lands.
 *
 * Distinct from Where You Buzz's Value tab, which prices four fixed quarters
 * -- this is a finer, unpriced distribution of *how often*, not *worth how
 * much*. Bin 0 is the earliest buzzes, bin `bins - 1` the latest.
 */
function drawBuzzSpread(data) {
  const frame = document.createDocumentFragment()
  const total = data.correct.reduce((a, b) => a + b, 0) + data.wrong.reduce((a, b) => a + b, 0)
  if (!total) return frame.append(emptyNote('Not enough buzzes yet.')), frame

  const width = 560
  const height = 250
  const svg = canvas(width, height)
  const left = 34
  const bottom = height - 34
  const top = 22
  const plotW = width - left - 12
  const plotH = bottom - top
  const gap = 3
  const barW = plotW / data.bins - gap
  const maxCount = Math.max(1, ...data.correct.map((c, i) => c + data.wrong[i]))

  svg.append(text(left, 12, 'Buzzes by where in the tossup, correct vs. neg',
    { 'font-size': 10, 'font-weight': 600, fill: INK }))

  for (let i = 0; i < data.bins; i++) {
    const x = left + i * (plotW / data.bins) + gap / 2
    const wrongH = (data.wrong[i] / maxCount) * plotH
    const correctH = (data.correct[i] / maxCount) * plotH
    const total_i = data.wrong[i] + data.correct[i]

    if (data.wrong[i] > 0) {
      const seg = tag('rect', { x, y: bottom - wrongH, width: barW, height: Math.max(wrongH, 0), fill: RED })
      svg.append(seg)
      attachTooltip(seg, (tip) => tooltipBody(tip, `Bin ${i} of ${data.bins}`,
        [`${data.wrong[i]} neg`, `${data.correct[i]} correct`]), { restoreFill: '#e57a76' })
    }
    if (data.correct[i] > 0) {
      // A 2px surface gap separates the two stacked segments, same as any two
      // touching marks in this app -- a border would add ink that isn't data.
      const seg = tag('rect', {
        x, y: bottom - wrongH - correctH, width: barW,
        height: Math.max(correctH - (data.wrong[i] > 0 ? 2 : 0), 0), fill: BLUE,
      })
      svg.append(seg)
      attachTooltip(seg, (tip) => tooltipBody(tip, `Bin ${i} of ${data.bins}`,
        [`${data.correct[i]} correct`, `${data.wrong[i]} neg`]), { restoreFill: BLUE_LIGHT })
    }
    if (total_i === 0) {
      svg.append(tag('rect', { x, y: bottom - 2, width: barW, height: 2, fill: GRID, opacity: 0.4 }))
    }
    svg.append(text(x + barW / 2, bottom + 14, i, { 'text-anchor': 'middle', 'font-size': 10 }))
  }

  svg.append(text(left, bottom + 28, 'Early buzz', { 'font-size': 10 }))
  svg.append(text(width - 62, bottom + 28, 'Late buzz', { 'font-size': 10 }))

  frame.append(svg, seriesLegend([{ colour: BLUE, label: 'Correct' }, { colour: RED, label: 'Neg' }]))
  frame.append(table(
    ['Bin (early → late)', 'Correct', 'Wrong', 'Total'],
    data.correct.map((c, i) => [i, c, data.wrong[i], c + data.wrong[i]])))
  return frame
}

// ----------------------------------------------------------- submission time --

/** How long you take to answer, correct vs. incorrect.
 *
 * Sent as raw seconds rather than pre-binned (see routes/stats.py's own
 * note) so the bin edges fit whatever range was actually played, the same
 * reason the desktop's matplotlib histogram picks its own edges instead of
 * fixed ones.
 */
function drawSubmissionTime(data) {
  const frame = document.createDocumentFragment()
  const all = data.correctTimes.concat(data.incorrectTimes)
  if (!all.length) return frame.append(emptyNote('Not enough answers with a recorded time yet.')), frame

  const bins = 10
  const max = Math.max(...all, 1)
  const edge = max / bins
  const correctBins = new Array(bins).fill(0)
  const wrongBins = new Array(bins).fill(0)
  for (const t of data.correctTimes) correctBins[Math.min(bins - 1, Math.floor(t / edge))]++
  for (const t of data.incorrectTimes) wrongBins[Math.min(bins - 1, Math.floor(t / edge))]++

  const width = 560
  const height = 250
  const svg = canvas(width, height)
  const left = 34
  const bottom = height - 34
  const top = 12
  const plotW = width - left - 12
  const plotH = bottom - top
  const gap = 3
  const barW = plotW / bins - gap
  const maxCount = Math.max(1, ...correctBins.map((c, i) => c + wrongBins[i]))

  for (let i = 0; i < bins; i++) {
    const x = left + i * (plotW / bins) + gap / 2
    const wrongH = (wrongBins[i] / maxCount) * plotH
    const correctH = (correctBins[i] / maxCount) * plotH
    if (wrongBins[i] > 0) {
      const seg = tag('rect', { x, y: bottom - wrongH, width: barW, height: Math.max(wrongH, 0), fill: RED })
      svg.append(seg)
      attachTooltip(seg, (tip) => tooltipBody(tip, `${(i * edge).toFixed(1)}s – ${((i + 1) * edge).toFixed(1)}s`,
        [`${wrongBins[i]} incorrect`, `${correctBins[i]} correct`]), { restoreFill: '#e57a76' })
    }
    if (correctBins[i] > 0) {
      const seg = tag('rect', {
        x, y: bottom - wrongH - correctH, width: barW,
        height: Math.max(correctH - (wrongBins[i] > 0 ? 2 : 0), 0), fill: BLUE,
      })
      svg.append(seg)
      attachTooltip(seg, (tip) => tooltipBody(tip, `${(i * edge).toFixed(1)}s – ${((i + 1) * edge).toFixed(1)}s`,
        [`${correctBins[i]} correct`, `${wrongBins[i]} incorrect`]), { restoreFill: BLUE_LIGHT })
    }
    if (i % 2 === 0) {
      svg.append(text(x + barW / 2, bottom + 14, `${(i * edge).toFixed(1)}s`,
        { 'text-anchor': 'middle', 'font-size': 9 }))
    }
  }

  frame.append(svg, seriesLegend([{ colour: BLUE, label: 'Correct' }, { colour: RED, label: 'Incorrect' }]))
  const medCorrect = median(data.correctTimes)
  const medWrong = median(data.incorrectTimes)
  const note = document.createElement('p')
  note.className = 'mt-3 text-xs text-text-muted'
  note.textContent =
    `Median time: ${medCorrect === null ? '—' : medCorrect.toFixed(1) + 's'} on correct answers, ` +
    `${medWrong === null ? '—' : medWrong.toFixed(1) + 's'} on incorrect.`
  frame.append(note)
  return frame
}

// -------------------------------------------------------------------- progress --

/** One calendar month of accuracy, and buzz point below it.
 *
 * Two small single-axis charts stacked, not one chart with two y-scales --
 * a dual axis invents a correlation from wherever the two scales happen to
 * line up (see the dataviz skill's anti-patterns.md, "the most common way a
 * chart misleads"). Accuracy and buzz point share nothing but the x-axis, so
 * that is the only thing they now share.
 *
 * Days with no play are drawn as gaps, not as zeroes: the API sends them with
 * a null accuracy for exactly this reason, and joining across them would draw
 * a fortnight away as a slide down to nothing.
 */
/** {chart, table} -- two separate fragments now, one per tab, rather than
 *  the chart and the table always stacked together with no way to see just
 *  one. Matches the desktop's own Chart/Table split for this panel. */
function drawProgress(data) {
  if (!data.hasData) {
    return { chart: emptyNote(data.evaluation), table: emptyNote(data.evaluation) }
  }

  const width = 720
  const rowH = 130
  const gap = 22
  const height = rowH * 2 + gap
  const svg = canvas(width, height)
  const left = 34
  const right = width - 16
  const plotW = right - left
  const step = plotW / Math.max(1, data.days.length - 1)

  const dayX = (day) => left + (day.dayOfMonth - 1) * step

  function xAxis(bottom) {
    for (const day of data.days) {
      if (day.dayOfMonth % 5 !== 0 && day.dayOfMonth !== 1) continue
      svg.append(text(dayX(day), bottom + 16, day.dayOfMonth, { 'text-anchor': 'middle', 'font-size': 10 }))
    }
  }

  // ---- top: accuracy ----
  const accBottom = rowH - 18
  svg.append(text(left, 12, 'Accuracy', { 'font-size': 10, 'font-weight': 600, fill: INK }))
  for (const pct of [0, 50, 100]) {
    const y = accBottom - (pct / 100) * (accBottom - 20)
    svg.append(tag('line', { x1: left, y1: y, x2: right, y2: y, stroke: GRID, opacity: 0.5 }))
    svg.append(text(left - 6, y + 4, `${pct}%`, { 'text-anchor': 'end', 'font-size': 10 }))
  }
  let previous = null
  for (const day of data.days) {
    const x = dayX(day)
    if (day.accuracy === null) { previous = null; continue }
    const y = accBottom - (day.accuracy / 100) * (accBottom - 20)
    if (previous) {
      svg.append(tag('line', { x1: previous.x, y1: previous.y, x2: x, y2: y, stroke: BLUE, 'stroke-width': 2 }))
    }
    // A day under the gate is drawn hollow: it happened, and its accuracy is
    // not steady enough to read a direction from.
    const dot = tag('circle', {
      cx: x, cy: y, r: 4.5, fill: day.reliable ? BLUE : SURFACE, stroke: BLUE, 'stroke-width': 1.5,
    })
    svg.append(dot)
    attachTooltip(dot, (tip) => tooltipBody(tip, day.date, [
      `${day.accuracy}% accuracy`, `${day.answers} answer${day.answers === 1 ? '' : 's'}`,
      ...(day.reliable ? [] : [`Fewer than ${data.minSample} answers — not compared`]),
    ]))
    previous = { x, y }
  }
  xAxis(accBottom)

  // ---- bottom: buzz point ----
  const buzzTop = rowH + gap
  const buzzBottom = height - 18
  svg.append(text(left, buzzTop - 10, 'Buzz point (fraction of tossup unread)',
    { 'font-size': 10, 'font-weight': 600, fill: INK }))
  for (const frac of [0, 0.5, 1]) {
    const y = buzzBottom - frac * (buzzBottom - buzzTop)
    svg.append(tag('line', { x1: left, y1: y, x2: right, y2: y, stroke: GRID, opacity: 0.5 }))
    svg.append(text(left - 6, y + 4, frac.toFixed(1), { 'text-anchor': 'end', 'font-size': 10 }))
  }
  previous = null
  for (const day of data.days) {
    const x = dayX(day)
    if (day.celerity === null) { previous = null; continue }
    const y = buzzBottom - day.celerity * (buzzBottom - buzzTop)
    if (previous) {
      svg.append(tag('line', { x1: previous.x, y1: previous.y, x2: x, y2: y, stroke: BLUE_LIGHT, 'stroke-width': 2 }))
    }
    const dot = tag('circle', {
      cx: x, cy: y, r: 4.5, fill: day.reliable ? BLUE_LIGHT : SURFACE, stroke: BLUE_LIGHT, 'stroke-width': 1.5,
    })
    svg.append(dot)
    attachTooltip(dot, (tip) => tooltipBody(tip, day.date, [
      `Buzzed with ${(day.celerity * 100).toFixed(0)}% of the tossup still unread`,
    ]))
    previous = { x, y }
  }
  xAxis(buzzBottom)

  const note = document.createElement('p')
  note.className = 'mt-3 text-xs text-text-muted'
  note.textContent =
    `${data.monthLabel}: ${data.monthDaysPlayed} day${data.monthDaysPlayed === 1 ? '' : 's'} ` +
    `played, ${data.monthAnswers} answers. Hollow points are days under ` +
    `${data.minSample} answers — shown, but not compared.`

  const finding = document.createElement('p')
  finding.className = 'mt-2 text-sm leading-relaxed'
  finding.textContent = data.evaluation

  const chartFrame = document.createDocumentFragment()
  chartFrame.append(svg, note, finding)

  const tableFrame = document.createDocumentFragment()
  const played = data.days.filter((d) => d.played)
  if (played.length) {
    tableFrame.append(table(
      ['Day', 'Answers', 'Correct', 'Negs', 'Accuracy', 'Buzz point', 'Points'],
      played.map((d) => [
        d.date, d.answers, d.correct, d.negs, `${d.accuracy}%`,
        d.celerity === null ? '—' : d.celerity.toFixed(3), d.points])))
  } else {
    tableFrame.append(emptyNote('No days played this month yet.'))
  }
  return { chart: chartFrame, table: tableFrame }
}

// ----------------------------------------------------------------- panels --

// `what` is the one-line description of the stat itself; the finding comes
// from the server, because it is the part that depends on the player.
// `perSession` marks the panels a session filter can actually reach. Most
// built on `user_stats` can: every row of it carries the sitting it came
// from. Retention, Knowledge Depth and Points by Category cannot -- see each
// panel's own comment for why.
//
// `views`, where present, is the Value/Spread/Table-style tab row desktop's
// own picker groups under one entry. Every view's data is fetched once, up
// front, when the panel is opened -- switching tabs re-renders from that
// cache rather than re-fetching, so it's instant and the "about this stat"
// finding (always drawn from the *first* view's data) never has to guess
// which tab supplied it.
const PANELS = [
  {
    key: 'buzzpoints', label: 'Where You Buzz', perSession: true,
    what: 'What a buzz is actually worth in each quarter of the tossup, in real points.',
    views: [
      // 'value' and 'table' both draw from the same api.buzzpoints() call --
      // sharing cacheKey (rather than each view's own `key`, the default) is
      // what makes that one fetch, not two: cache.get keys on this string,
      // and Promise.all fires every view's loader at once, so without it two
      // views wanting the same data raced two simultaneous fetches for it.
      { key: 'value', cacheKey: 'buzzpoints', label: 'Value', title: 'What a buzz in each quarter is worth',
        load: (category, session) => api.buzzpoints(category, session), draw: drawBuzzpointsValue },
      { key: 'spread', label: 'Spread', title: 'How often you buzz at each point, and how those turned out',
        load: (category, session) => api.buzzSpread(category, session), draw: drawBuzzSpread },
      { key: 'table', cacheKey: 'buzzpoints', label: 'Table',
        load: (category, session) => api.buzzpoints(category, session), draw: drawBuzzpointsTable },
    ],
    finding: (d) => d.evaluation,
  },
  {
    key: 'ceiling', label: 'Ceiling', perSession: true,
    what: 'How well you convert at each difficulty, and the tournaments those difficulties are.',
    views: [
      { key: 'chart', cacheKey: 'ceiling', label: 'Chart',
        load: (category, session) => api.ceiling(category, session), draw: drawCeiling },
      { key: 'table', cacheKey: 'ceiling', label: 'Table',
        load: (category, session) => api.ceiling(category, session), draw: drawCeilingTable },
    ],
    finding: (d) => d.evaluation,
  },
  {
    key: 'negs', label: 'Neg Autopsy', perSession: true,
    what: 'Whether your negs track when you buzz or what you buzzed on — the two want opposite fixes.',
    views: [
      { key: 'grid', cacheKey: 'negAutopsy', label: 'Grid', title: 'Neg rate for each difficulty and buzz point',
        load: (category, session) => api.negAutopsy(category, session), draw: drawNegAutopsyGrid },
      { key: 'breakdown', cacheKey: 'negAutopsy', label: 'Breakdown', title: 'Neg rate along each axis on its own',
        load: (category, session) => api.negAutopsy(category, session), draw: drawNegAutopsyBreakdown },
    ],
    finding: (d) => d.evaluation,
  },
  {
    key: 'outcomeSplit', label: 'Outcome Split', perSession: true,
    what: 'Every tossup you\'ve buzzed on: converted, or negged.',
    load: async (category, session) => (await api.stats(category, session)).lifetime,
    draw: drawOutcomeSplit,
    finding: (d) => {
      const total = d.powers + d.tens + d.negs
      if (!total) return 'No buzzes recorded yet.'
      return `${((((d.powers + d.tens) / total)) * 100).toFixed(0)}% converted, ` +
        `${((d.negs / total) * 100).toFixed(0)}% negged, across ${total} buzzes.`
    },
  },
  {
    key: 'retention', label: 'Retention', perSession: false,
    what: 'Whether what you get right stays right, per subject, from the review schedule.',
    load: (category) => api.retention(category),
    draw: drawRetention,
    finding: (d) => d.summary,
  },
  {
    key: 'knowledgeDepth', label: 'Knowledge Depth', perSession: false,
    what: 'The recommender\'s own per-cluster skill model, made readable — where inside a subject you\'re actually thin.',
    load: (category) => api.knowledgeDepth(category),
    draw: drawKnowledgeDepth,
    finding: (d) => d.evaluation,
  },
  {
    key: 'pointsByCategory', label: 'Points by Category', perSession: false,
    what: 'Total points earned in each category, so every subject can be weighed against every other one at once.',
    load: () => api.pointsByCategory(),
    draw: drawPointsByCategory,
    finding: (d) => {
      if (!d.categories.length) return 'No categories played yet.'
      const best = d.categories[0]
      const worst = d.categories[d.categories.length - 1]
      if (best === worst) return `${best.category}: ${best.points > 0 ? '+' : ''}${best.points} points.`
      return `Best: ${best.category} (${best.points > 0 ? '+' : ''}${best.points}). ` +
        `Worst: ${worst.category} (${worst.points > 0 ? '+' : ''}${worst.points}).`
    },
  },
  {
    key: 'aggressivePlay', label: 'Think Then Buzz', perSession: true,
    what: 'Whether it pays to buzz early on a hunch and work the answer out after, or to wait.',
    load: (category, session) => api.aggressivePlay(category, session),
    draw: drawAggressivePlay,
    finding: (d) => d.evaluation,
  },
  {
    key: 'submissionTime', label: 'Thinking Time', perSession: true,
    what: 'How long you take to answer once buzzed, correct vs. incorrect.',
    load: (category, session) => api.submissionTime(category, session),
    draw: drawSubmissionTime,
    finding: (d) => {
      const all = d.correctTimes.concat(d.incorrectTimes)
      if (!all.length) return 'Not enough answers with a recorded time yet.'
      const mc = median(d.correctTimes)
      const mw = median(d.incorrectTimes)
      if (mc === null || mw === null) return `${all.length} answers with a recorded time.`
      return mc <= mw
        ? `You answer faster when you're right (median ${mc.toFixed(1)}s vs ${mw.toFixed(1)}s on misses).`
        : `You answer faster when you're wrong (median ${mw.toFixed(1)}s vs ${mc.toFixed(1)}s on hits) — worth noticing.`
    },
  },
]

// ------------------------------------------------------------------ wiring --

/** Panel data, remembered for as long as the scope it was fetched under holds.
 *
 *  Every panel is its own request, and switching panels re-fired it every time
 *  -- clicking Buzz Points, then Ceiling, then back to Buzz Points cost three
 *  round trips for two distinct answers, each one a full Railway -> Supabase
 *  hop. None of it can have changed in between: nothing on the Profile screen
 *  writes an answer.
 *
 *  It also closes a duplicate that was invisible from the code: the Outcome
 *  Split panel loads `api.stats(...)` and so does the stat-tile row above it,
 *  so opening the Profile fetched `/api/stats/summary` twice every time. Both
 *  now share one in-flight promise.
 *
 *  Keyed by scope, and the *promise* is stored rather than the resolved value,
 *  so two callers racing for the same data make one request rather than two.
 *  `clear()` runs whenever the category filter, the session or the month
 *  changes -- anything that makes the stored answers describe a different
 *  question -- and whenever the screen is reopened, so a sitting played since
 *  last time is never served from memory.
 */
function makePanelCache() {
  let store = new Map()
  return {
    get(key, fetcher) {
      if (!store.has(key)) {
        // A failed request must not be cached as a permanent failure: drop it
        // so the next attempt is a real retry rather than the same rejection.
        const promise = fetcher().catch((error) => {
          store.delete(key)
          throw error
        })
        store.set(key, promise)
      }
      return store.get(key)
    },
    clear() { store = new Map() },
  }
}

/** Warm the cache for every panel other than the one just rendered, so the
 *  first click on each of the rest of the picker is answered from memory
 *  instead of paying its own Railway -> Supabase round trip -- today only the
 *  panel actually clicked gets fetched, so a reader working through Buzz
 *  Points, then Ceiling, then Neg Autopsy pays three fresh fetches for a page
 *  that had every one of those numbers within reach the moment it opened.
 *
 *  Sequential, not `Promise.all`: these are real hosted-database queries, and
 *  firing every remaining panel's queries at once just because the page
 *  loaded is the kind of thing that's free against a local Postgres and not
 *  against Railway. One at a time keeps this from ever being the biggest
 *  thing hitting the API at once.
 *
 *  Fire-and-forget, same contract as browse.js's `prefetchNeighbors`: a slow
 *  or failed prefetch just leaves that panel uncached, same as before this
 *  existed, and a real click on it pays the round trip itself as always.
 *
 *  `keyFor`/`loadFor` take a panel (and, for a multi-view one, its view) and
 *  build the same cache key and fetcher `loadPanel` itself would -- so this
 *  has to be handed the *same* two functions the caller's own cache.get calls
 *  use, or a prefetch here would warm a key a real click never asks for. */
async function primeOtherPanels(panels, current, cache, keyFor, loadFor) {
  for (const panel of panels) {
    if (panel.key === current) continue
    try {
      if (panel.views) {
        for (const v of panel.views) {
          await cache.get(keyFor(panel, v), () => loadFor(panel, v))
        }
      } else {
        await cache.get(keyFor(panel), () => loadFor(panel))
      }
    } catch { /* leave it uncached -- see the note above */ }
  }
}

export function initProfile(el) {
  const cache = makePanelCache()
  let current = PANELS[0].key
  let month = null
  // The saved Adaptive Learning sitting this page is scoped to, or null for
  // the whole account. Set only by the records page.
  let session = null
  // Which tab is active per multi-view panel, kept across re-renders of the
  // same panel (a category-filter change, for instance) but not meant to
  // persist across switching to a different panel entirely.
  let activeViewKey = null
  // Progress Over Time's own Chart/Table tab -- kept across month navigation
  // and category changes, the same way activeViewKey survives a panel
  // re-render, since switching months shouldn't silently switch you back to
  // Chart if you'd been reading the Table.
  let progressView = 'chart'
  let progressData = null
  let panelRequest = 0
  let progressRequest = 0

  const visiblePanels = () =>
    session ? PANELS.filter((p) => p.perSession) : PANELS

  function pickerButtons() {
    el.statPicker.innerHTML = ''
    for (const panel of visiblePanels()) {
      const button = document.createElement('button')
      button.textContent = panel.label
      button.className = 'rounded-full px-4 py-2 text-sm font-bold ' +
        (panel.key === current ? 'bg-[#efe0db] text-[#1d1816]' : 'bg-tertiary-dark')
      button.addEventListener('click', () => {
        current = panel.key
        activeViewKey = null
        pickerButtons()
        loadPanel()
      })
      el.statPicker.append(button)
    }
  }

  async function loadPanel() {
    const panel = PANELS.find((p) => p.key === current)
    const category = session ? '' : el.profileCategoryFilter.value
    el.statView.textContent = 'Loading…'
    el.statAboutTitle.textContent = panel.label
    el.statAboutWhat.textContent = panel.what
    el.statAboutFinding.textContent = ''
    el.statSubPicker.innerHTML = ''
    const requestId = ++panelRequest
    try {
      if (panel.views) {
        const datasets = await Promise.all(panel.views.map((v) =>
          cache.get(`${panel.key}|${v.cacheKey ?? v.key}|${category}|${session?.sessionId ?? ''}`,
                    () => v.load(category, session?.sessionId))))
        // Switching panels again before this one's fetches land must not
        // paint its stats underneath the now-highlighted panel button.
        if (requestId !== panelRequest) return
        if (!activeViewKey || !panel.views.some((v) => v.key === activeViewKey)) {
          activeViewKey = panel.views[0].key
        }
        const render = () => {
          el.statSubPicker.innerHTML = ''
          el.statSubPicker.append(toggleRow(panel.views, activeViewKey, (key) => {
            activeViewKey = key
            render()
          }))
          el.statView.innerHTML = ''
          const idx = panel.views.findIndex((v) => v.key === activeViewKey)
          el.statView.append(panel.views[idx].draw(datasets[idx]))
        }
        render()
        el.statAboutFinding.textContent = panel.finding(datasets[0])
      } else {
        const data = await cache.get(
          `${panel.key}||${category}|${session?.sessionId ?? ''}`,
          () => panel.load(category, session?.sessionId))
        if (requestId !== panelRequest) return
        el.statView.textContent = ''
        el.statView.append(panel.draw(data))
        el.statAboutFinding.textContent = panel.finding(data)
      }
    } catch (error) {
      el.statView.textContent = error.message
      return
    }
    // Not awaited: the panel actually asked for is already on screen, and the
    // rest of the picker is a "might click it later" bet, not something this
    // render should wait on.
    // v.cacheKey ?? v.key here too, not just in the real loadPanel() above --
    // this was still bare v.key, which meant the prefetch for buzzpoints/
    // ceiling/negAutopsy (whose views share one cacheKey specifically so one
    // fetch answers both tabs) wrote its warm entries under a key
    // loadPanel() never reads, and fetched each of those panels' shared call
    // *twice* in the background for no benefit -- a real regression, not a
    // no-op: extra Railway round trips with nothing to show for them, and
    // the panel still cache-misses on the first real click regardless.
    primeOtherPanels(visiblePanels(), current, cache,
      (p, v) => v ? `${p.key}|${v.cacheKey ?? v.key}|${category}|${session?.sessionId ?? ''}`
                   : `${p.key}||${category}|${session?.sessionId ?? ''}`,
      (p, v) => (v ?? p).load(category, session?.sessionId))
  }

  async function loadProgress() {
    const category = el.profileCategoryFilter.value
    el.progressChartView.textContent = 'Loading…'
    el.progressTableView.textContent = ''
    const requestId = ++progressRequest
    try {
      const data = await api.progress(category, month)
      if (requestId !== progressRequest) return
      progressData = data
      renderProgressViews()
      renderMonthNav(data)
    } catch (error) {
      el.progressChartView.textContent = error.message
    }
  }

  function progressViewButtons() {
    el.progressViewPicker.innerHTML = ''
    for (const view of [{ key: 'chart', label: 'Chart' }, { key: 'table', label: 'Table' }]) {
      const button = document.createElement('button')
      button.textContent = view.label
      button.className = 'rounded-full px-3 py-1 text-xs font-bold ' +
        (view.key === progressView ? 'bg-[#efe0db] text-[#1d1816]' : 'bg-tertiary-dark text-text-muted')
      button.addEventListener('click', () => {
        progressView = view.key
        progressViewButtons()
        el.progressChartView.classList.toggle('hidden', progressView !== 'chart')
        el.progressTableView.classList.toggle('hidden', progressView !== 'table')
      })
      el.progressViewPicker.append(button)
    }
  }

  function renderProgressViews() {
    const { chart, table } = drawProgress(progressData)
    el.progressChartView.innerHTML = ''
    el.progressChartView.append(chart)
    el.progressTableView.innerHTML = ''
    el.progressTableView.append(table)
    el.progressChartView.classList.toggle('hidden', progressView !== 'chart')
    el.progressTableView.classList.toggle('hidden', progressView !== 'table')
    progressViewButtons()
  }

  /** Month paging. Only months with play in them are offered -- stepping
   *  through empty months looking for data is not navigation. */
  function renderMonthNav(data) {
    el.progressNav.innerHTML = ''
    if (!data.months?.length) return
    const index = data.months.findIndex((m) => m.key === data.month)

    const step = (delta, label) => {
      const target = data.months[index + delta]
      const button = document.createElement('button')
      button.textContent = label
      button.disabled = !target
      button.className = 'rounded-full bg-tertiary-dark px-3 py-1 text-sm font-bold disabled:opacity-30'
      button.addEventListener('click', () => { month = target.key; loadProgress() })
      return button
    }

    const label = document.createElement('span')
    label.className = 'text-sm font-bold'
    label.textContent = data.monthLabel

    el.progressNav.append(step(-1, '← Earlier'), label, step(1, 'Later →'))
  }

  async function loadLifetime() {
    const category = session ? '' : el.profileCategoryFilter.value
    // Same key the Outcome Split panel uses, so the two share one request.
    const lifetime = await cache.get(
      `outcomeSplit||${category}|${session?.sessionId ?? ''}`,
      async () => (await api.stats(category, session?.sessionId)).lifetime)
    el.profileTossupsHeard.textContent = lifetime.tossups
    el.profilePoints.textContent = lifetime.points
    el.profilePowers.textContent = lifetime.powers
    el.profileTens.textContent = lifetime.tens
    el.profileNegs.textContent = lifetime.negs
    el.profileCelerity.textContent = lifetime.averageCelerity === null
      ? '0.000' : lifetime.averageCelerity.toFixed(3)
  }

  el.profileCategoryFilter.addEventListener('change', () => {
    // A category change resets the month: the month that had play in it for
    // Science may have none for Literature, and holding a stale key would
    // silently fall back while the nav still read like a choice.
    month = null
    cache.clear()          // every cached answer was for the previous category
    loadLifetime()
    loadPanel()
    loadProgress()
  })

  /** What a session filter takes off the page, and why it says so.
   *
   *  Under a session filter the category picker is meaningless (the sitting
   *  already is one subject), Progress Over Time cannot be answered at all
   *  (`progress_daily` has no session column, because a day outlives the
   *  sitting), and Retention is answered from the review queue rather than
   *  from answers. Hiding them silently would leave the reader to work out
   *  why the page changed shape, so the banner says it. */
  function applyScope() {
    const scoped = Boolean(session)
    el.profileTitle.textContent = scoped ? 'One Saved Session' : 'Your Profile'
    el.profileCategoryLabel.classList.toggle('hidden', scoped)
    // Resetting the account's lifetime stats is not an action that makes
    // sense while looking at one saved sitting.
    el.resetStatsBtn.classList.toggle('hidden', scoped)
    el.progressSection.classList.toggle('hidden', scoped)
    el.profileSessionNotice.classList.toggle('hidden', !scoped)
    el.profileSessionNotice.classList.toggle('flex', scoped)

    if (scoped) {
      const played = session.endedAt ? new Date(session.endedAt).toLocaleString() : ''
      el.profileSessionText.textContent =
        `${session.category}${played ? `, ${played}` : ''} — ` +
        `${session.correctAnswers ?? 0} of ${session.questionsAnswered ?? 0} correct. ` +
        'Retention and Progress Over Time are not shown: they come from your ' +
        'review queue and your practice calendar, which outlive any one sitting.'
    }

    // A panel that a session cannot answer must not stay selected when one is
    // applied, or the picker would show no button pressed and load nothing.
    if (!visiblePanels().some((p) => p.key === current)) current = PANELS[0].key
  }

  el.profileExitSessionBtn.addEventListener('click', () => {
    session = null
    month = null
    cache.clear()
    applyScope()
    pickerButtons()
    loadLifetime()
    loadPanel()
    loadProgress()
  })

  /** Rebuild the category filter from what this account has actually played.
   *
   *  It used to be handed the reader's own list -- every category in the
   *  question library -- which offered subjects the player had never touched,
   *  and picking one opened a profile with nothing on it. `played-categories`
   *  is the route the desktop has always used for this, and it answers the
   *  question the filter is actually asking: not "what exists" but "what have
   *  you answered". It also returns *sub*categories, which the library list
   *  never surfaced here even though the server's own `_scope()` matches
   *  either level -- so the web filter could not scope to a shelf at all.
   *
   *  Fails soft: the panels below do not depend on this list, so a failed
   *  request leaves "Every category" selectable rather than blanking a page
   *  whose numbers loaded fine. */
  async function loadCategoryFilter() {
    const chosen = el.profileCategoryFilter.value
    let played = { categories: [], subcategories: [] }
    try {
      played = await api.playedCategories()
    } catch (error) {
      console.error(error)
    }

    el.profileCategoryFilter.innerHTML = '<option value="">Every category</option>'
    const add = (name, answers, indent) => {
      const option = document.createElement('option')
      option.value = name
      // Counts, and an indent on the shelves, so the two levels read as a
      // hierarchy in a flat <select> -- the desktop marks the same split with
      // an opacity change on its filter buttons.
      option.textContent = `${indent ? '  ' : ''}${name} (${answers})`
      el.profileCategoryFilter.append(option)
    }
    for (const c of played.categories ?? []) add(c.name, c.answers, false)
    for (const s of played.subcategories ?? []) add(s.name, s.answers, true)

    // A filter that is no longer on the list -- every answer in it was just
    // reset -- falls back to "Every category" rather than staying selected on
    // an option that no longer exists.
    el.profileCategoryFilter.value = chosen
    if (el.profileCategoryFilter.value !== chosen) {
      el.profileCategoryFilter.value = ''
    }
  }

  /** Called every time the page is opened, so it never shows stale numbers
   *  from before the last session's answers. `scope` is a saved Adaptive
   *  Learning record when the records page opened it, and null otherwise. */
  return function showProfile(scope = null) {
    session = scope
    if (session) month = null
    // Dropped on every open, not just on a scope change: a tossup answered
    // since the last visit would otherwise be missing from numbers served out
    // of memory, and "it never shows stale numbers" is the whole contract of
    // reloading here.
    cache.clear()

    // Not awaited: the filter is a control, not a prerequisite for the
    // numbers, and blocking the whole page on it would make opening the
    // profile wait for a request nothing on screen needs yet.
    loadCategoryFilter()

    applyScope()
    pickerButtons()
    loadLifetime()
    loadPanel()
    if (!session) loadProgress()
  }
}

/** The panel picker alone, scoped to one saved session, for the records
 *  list's inline detail -- reuses the same `PANELS` and draw functions
 *  `initProfile` does, so the charts stay one implementation, but targets its
 *  own elements rather than the full Profile screen's. records.js supplies
 *  the identity/stat-tile row itself, since that data is already sitting in
 *  the row that was clicked and needs no extra round trip. */
export function initSessionPanels(el) {
  // Records expands a sitting inline and lets you flick between its panels;
  // without this, each flick re-fetched a session whose answers are finished
  // and cannot change. Cleared when a different sitting is opened.
  const cache = makePanelCache()
  const panels = PANELS.filter((p) => p.perSession)
  let current = panels[0].key
  let activeViewKey = null
  let sessionId = null
  let panelRequest = 0

  function pickerButtons() {
    el.statPicker.innerHTML = ''
    for (const panel of panels) {
      const button = document.createElement('button')
      button.textContent = panel.label
      button.className = 'rounded-full px-4 py-2 text-sm font-bold ' +
        (panel.key === current ? 'bg-[#efe0db] text-[#1d1816]' : 'bg-tertiary-dark')
      button.addEventListener('click', () => {
        current = panel.key
        activeViewKey = null
        pickerButtons()
        loadPanel()
      })
      el.statPicker.append(button)
    }
  }

  async function loadPanel() {
    const panel = panels.find((p) => p.key === current)
    el.statView.textContent = 'Loading…'
    el.statAboutTitle.textContent = panel.label
    el.statAboutWhat.textContent = panel.what
    el.statAboutFinding.textContent = ''
    el.statSubPicker.innerHTML = ''
    const requestId = ++panelRequest
    try {
      if (panel.views) {
        const datasets = await Promise.all(panel.views.map((v) =>
          cache.get(`${panel.key}|${v.cacheKey ?? v.key}|${sessionId}`, () => v.load('', sessionId))))
        // A quick second click -- another panel, or another sitting entirely
        // -- must not paint this stale fetch over what is on screen now.
        if (requestId !== panelRequest) return
        if (!activeViewKey || !panel.views.some((v) => v.key === activeViewKey)) {
          activeViewKey = panel.views[0].key
        }
        const render = () => {
          el.statSubPicker.innerHTML = ''
          el.statSubPicker.append(toggleRow(panel.views, activeViewKey, (key) => {
            activeViewKey = key
            render()
          }))
          el.statView.innerHTML = ''
          const idx = panel.views.findIndex((v) => v.key === activeViewKey)
          el.statView.append(panel.views[idx].draw(datasets[idx]))
        }
        render()
        el.statAboutFinding.textContent = panel.finding(datasets[0])
      } else {
        const data = await cache.get(`${panel.key}||${sessionId}`,
                                     () => panel.load('', sessionId))
        if (requestId !== panelRequest) return
        el.statView.textContent = ''
        el.statView.append(panel.draw(data))
        el.statAboutFinding.textContent = panel.finding(data)
      }
    } catch (error) {
      el.statView.textContent = error.message
      return
    }
    // Not awaited -- see the profile picker's own copy of this call above.
    // Same v.cacheKey ?? v.key fix as initProfile's own copy of this call.
    primeOtherPanels(panels, current, cache,
      (p, v) => v ? `${p.key}|${v.cacheKey ?? v.key}|${sessionId}` : `${p.key}||${sessionId}`,
      (p, v) => (v ?? p).load('', sessionId))
  }

  return function showSessionPanels(newSessionId) {
    // A different sitting is a different scope; a re-open of the same one is
    // not, and its answers are finished, so that case keeps its cache.
    if (newSessionId !== sessionId) cache.clear()
    sessionId = newSessionId
    current = panels[0].key
    activeViewKey = null
    pickerButtons()
    loadPanel()
  }
}
