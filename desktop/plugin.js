/**
 * Hermes Worker Monitor: desktop half.
 *
 * One footer item (STATUSBAR_AREAS.right) showing the Kanban board groups, in
 * the board's own column order (its backlog first, then work, then the states a
 * person still has to look at, then the day's finished cards). The running count
 * carries a state dot, colored by the worst running worker (looping beats
 * stalled beats active).
 *
 * Hovering a count opens a popover with the cards behind that number. Hovering
 * one of those rows opens the whole card in a centered overlay over the app, the
 * way a fuzzy finder floats in the middle of the screen: the title, the fields,
 * the description, the newest run, the recent comments and the attachments,
 * which is what the board's own drawer shows. It is the app's own dialog shell,
 * the app's own panel parts and the app's own chat markdown renderer, so a card
 * reads here the way it reads on the Kanban page and the two cannot drift.
 *
 * Nothing here needs a precise pointer. The card opens after a short rest on a
 * row, and both layers stay up while the pointer is on any of our chrome (the
 * strip, the list, the card overlay), with a heartbeat rather than a countdown
 * as the close timer. A pointer in the gap between the list and the overlay is
 * mid journey, not gone, and the overlay is a large fixed target in the middle
 * of the screen instead of a small box wedged against a row.
 *
 * Clicking a count, or a card in a list, opens the board. Escape, a click
 * outside, or the close button dismisses the card. The card overlay is
 * read-only: a plugin cannot reach the Kanban plugin's own API, so the actions
 * (complete, block, comment, attach) still live in the board's drawer, one click
 * away.
 *
 * A chip is an icon and a count, nothing else: the group's name lives in the
 * list header, and the chips sit close together.
 *
 * This fork reads counts, card fields and the one card's body. There is no quota
 * item, so the desktop half never asks the backend for provider data and no
 * credential reaches it.
 *
 * Polling goes through `ctx.rest` (namespace-relative paths only, see the
 * plugin contract) with React Query `refetchInterval`, so the timer is torn
 * down automatically when the item unmounts and the plugin is disabled or
 * hot-reloaded. A failed request never leaves stale numbers on screen. The card
 * list is fetched only while its popover is open, and one card's detail only
 * while it is the card on show.
 *
 * Plain ESM, loaded uncompiled: the UI is `jsx()` calls, not JSX syntax. Only
 * `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` resolve.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  MessageTextContent,
  PanelBlock,
  PanelListRow,
  PanelMeta,
  PanelPill,
  PanelSectionLabel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSBAR_AREAS,
  atom,
  host,
  icons,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { Component, useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-worker-monitor'

// How long to keep looking for a card on the board after landing there. The
// board fetches and paints its columns first, and a local fetch is quick.
const CARD_OPEN_TIMEOUT_MS = 2500

// The board page inside the app. `host.navigate` drives the app router.
const BOARD_PATH = '/kanban'

// Polling cadence (ms). Never below 10s.
const SUMMARY_INTERVAL_MS = 10_000

// Cards requested per list. The header always shows the group's real total from
// the same payload the strip counts, so a capped list never reads as the whole
// board.
const CARD_LIMIT = 25

// How long the pointer must rest on a row before its card opens. A sweep across
// the list must not flash a full screen overlay at every row it crosses.
const CARD_OPEN_DWELL_MS = 130

// How long a layer waits for the pointer to reach it. The timer is a heartbeat,
// not a countdown: while pointer events keep arriving on our chrome, the hover
// stays, however slow the path is. The card overlay is in the middle of the
// screen and the list is in a corner, so that journey is the long one, and a
// pointer crossing it is mid journey, not gone.
const HOVER_CLOSE_MS = 1000

// Leaving the list with nothing else on show: a beat, not a wait. There is
// nowhere the pointer could be heading, so the list simply goes.
const LIST_EXIT_MS = 300

// ONE hover at a time: the open chip and, inside it, the card on show. Every
// part reports into this one atom, so moving anywhere else closes what it left
// behind instead of leaving panels across the screen.
const $hover = atom(null)
let closeTimer = null
let lastInsideAt = 0

function clearCloseTimer() {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

/** The pointer is on our chrome: hold the hover. */
function markInside() {
  lastInsideAt = Date.now()
  clearCloseTimer()
}

/** Take the chip's slot, closing whatever was open. */
function hoverSlot(slot) {
  markInside()
  const hover = $hover.get()
  if (hover === null || hover.slot !== slot) {
    $hover.set({ slot, card: null })
  }
}

/** Take the card, keeping its chip open behind it. */
function hoverCard(slot, card) {
  markInside()
  const hover = $hover.get()
  if (hover === null || hover.slot !== slot || hover.card !== card) {
    $hover.set({ slot, card })
  }
}

/** Drop the card overlay but keep the list it came from. */
function clearCard() {
  cancelScheduledCard()
  clearCloseTimer()
  const hover = $hover.get()
  if (hover === null || hover.card === null) return
  $hover.set(hover.slot === null ? null : { slot: hover.slot, card: null })
}

/**
 * Leave the list. There are two ways out and they are not the same: with a card
 * on show the pointer may be on its way to that card, so the hover is held for
 * the trip; with nothing on show there is nowhere to travel and the list leaves
 * on a short beat.
 *
 * Both check the pointer's own position first, because a leave fired under a
 * STATIONARY pointer is the browser replacing the element under it, not a real
 * exit, and closing on that would make the list vanish while it is being read.
 */
function releaseList(event) {
  if (stillInside(event)) {
    markInside()
    return
  }
  cancelScheduledCard()
  const hover = $hover.get()
  if (hover === null) return
  // A card on show means the pointer may be crossing to it, and that crossing is
  // long: the whole hover is held for the trip, refreshed by every move onto the
  // card and ended by the timer if the pointer never arrives. With nothing on
  // show there is nowhere to go, so the list leaves on the short beat instead of
  // waiting out a trip nobody is taking.
  releaseAfter(hover.card === null ? LIST_EXIT_MS : HOVER_CLOSE_MS)
}

/**
 * Ask for the hover to be released. The timer re-checks the heartbeat first, so
 * a timer left over from another chip can never close a panel the pointer has
 * since moved onto, and a slow journey never loses the race.
 */
function releaseAfter(delayMs) {
  clearCloseTimer()
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (Date.now() - lastInsideAt < delayMs) {
      releaseAfter(delayMs)
      return
    }
    $hover.set(null)
  }, delayMs)
}

function releaseSlot() {
  cancelScheduledCard()
  releaseAfter(HOVER_CLOSE_MS)
}

/**
 * True when the pointer is still over our chrome, whatever a leave event claims.
 *
 * A browser fires pointerout with no related target whenever the element under a
 * STATIONARY pointer is replaced, and rows arriving or a card re-rendering does
 * exactly that. Left alone, that reads as the pointer leaving, and a panel that
 * closes at once would vanish while it is being read. The pointer's own position
 * is the honest answer, so ask it: every layer names itself with data-hwm-layer.
 */
function stillInside(event) {
  const x = event?.clientX
  const y = event?.clientY
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return false
  const under = document.elementsFromPoint(x, y)
  return under.some(node => Boolean(node.closest?.('[data-hwm-layer]')))
}

/**
 * Leave the card. The trip IN earns a grace, because a pointer crossing the
 * screen to a panel is on its way there; the way OUT does not, because once the
 * card has been read and the pointer moves off it, it should be gone. The list
 * it came from keeps the usual grace, so walking from the card back down to
 * another row still works and the list is what closes last.
 */
function releaseCardNow(event) {
  if (stillInside(event)) {
    markInside()
    return
  }
  cancelScheduledCard()
  clearCard()
  releaseSlot()
}

/** Release the hover now: escape, a board navigation, or unmount. */
function closeHover() {
  cancelScheduledCard()
  clearCloseTimer()
  if ($hover.get() !== null) $hover.set(null)
}

/**
 * What the pointer is over, from the pointer event itself. The strip owns this
 * decision, so a panel under the pointer cannot win it by being under the
 * pointer.
 */
function slotUnder(event) {
  const chip = event.target?.closest?.('[data-hwm-slot]')
  return chip ? chip.getAttribute('data-hwm-slot') : null
}

// A row asks for its card after a rest on it, not at once.
let openTimer = null

function cancelScheduledCard() {
  if (openTimer !== null) {
    clearTimeout(openTimer)
    openTimer = null
  }
}

function scheduleCard(slot, card) {
  markInside()
  if (openTimer !== null) clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    openTimer = null
    hoverCard(slot, card)
  }, CARD_OPEN_DWELL_MS)
}

// Traffic-light colors for the running state. Mid-saturation hues that stay
// legible on both the light and dark themes.
const GREEN = '#30d158'
const AMBER = '#ff9f0a'
const RED = '#ff6b60'
const STATE_COLOR = { active: GREEN, stalled: AMBER, loop: RED }

// Shared chrome styling for interactive statusbar items (matches core). Core
// already uses both classes here, so the prebuilt Tailwind bundle carries them.
const ITEM_CLASS = 'whitespace-nowrap rounded-md transition-colors hover:bg-(--chrome-action-hover)'

// Row layout lives in inline styles. The desktop app ships a prebuilt Tailwind
// bundle: arbitrary utilities used only by plugins are never generated, so a
// layout that leans on them can silently collapse inside the statusbar. Inline
// styles always apply.
//
// The strip is icons and counts only, so the chips sit as close as they can
// while still reading as separate targets.
const ITEM_STYLE = {
  alignItems: 'center',
  display: 'inline-flex',
  fontSize: '0.6875rem',
  gap: '0.1875rem',
  height: '1.25rem',
  padding: '0 0.25rem'
}
const STRIP_STYLE = {
  display: 'inline-flex',
  flexDirection: 'row',
  alignItems: 'center',
  whiteSpace: 'nowrap',
  gap: '0.125rem'
}
const DOT_STYLE = { width: '0.375rem', height: '0.375rem', flex: '0 0 auto', borderRadius: '999px' }
const LABEL_COLOR = 'var(--ui-text-quaternary)'
const QUIET_COLOR = 'var(--ui-text-tertiary)'

// The app's own Kanban counter (the core plugin, order 80) sits beside this
// strip and reports the same board: a project glyph and the number of running
// plus ready cards, which this strip already covers. Hiding it the honest way is
// not open to a plugin: a render style statusbar item is never listed in the
// bar's own show/hide menu (that menu lists only declarative items that name
// themselves with a label), and one plugin cannot unregister another plugin's
// contribution. So the one live way to drop the duplicate is a stylesheet rule,
// scoped to the statusbar and to the single item that carries the project glyph.
// Delete this constant and the counter comes straight back.
const CORE_COUNTER_STYLE_ID = 'hermes-worker-monitor-hide-core-counter'
const HIDE_CORE_COUNTER_CSS = '[data-slot="statusbar"] button:has(.codicon-project){display:none}'

function hideCoreCounter() {
  if (document.getElementById(CORE_COUNTER_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = CORE_COUNTER_STYLE_ID
  style.textContent = HIDE_CORE_COUNTER_CSS
  document.head.appendChild(style)
}

// The list rides above the card (--z-modal is 130) and above the dim behind
// it (--z-modal-backdrop is 120). It has to be on top: the centered card overlaps
// the list's upper rows, and anything sitting over a row swallows that row's
// click, so the row that opens the board has to be what the pointer actually
// hits. Numeric, not a class: the plugin must not depend on a Tailwind utility
// the app's prebuilt bundle may not carry.
const POPOVER_STYLE = { width: '22rem', maxWidth: '90vw', zIndex: 125 }
// Capped so the list's whole band stays under about 16rem: the card's geometry
// (see CARD_STYLE) is measured against that, so a taller list would break the
// guarantee that the two never overlap.
const LIST_BODY_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '14rem',
  overflowY: 'auto'
}
const NOTE_STYLE = { color: QUIET_COLOR, fontSize: '0.6875rem', lineHeight: 1.4, padding: '0.375rem' }
const COLUMN_STYLE = { display: 'flex', flexDirection: 'column' }
const STACK_STYLE = { display: 'flex', flexDirection: 'column', gap: '0.375rem' }
const SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '0.25rem' }

// The card overlay: a fixed surface across the middle, sized by inline style so
// it does not depend on a Tailwind utility the plugin's bundle may not carry.
//
// The cap is the point. The list is anchored above the statusbar and is at most
// about 16rem tall, so a card centred at 38 percent of the viewport and capped
// at 100vh minus 26rem can never reach that band, on any screen size. That is
// what lets the card be the surface ON TOP (z 130 over the list's 125) while
// every row in the list stays clickable: an uncapped dialog would reach down into
// the list and swallow the row clicks.
// `translate`, not `transform`: the dialog shell centres itself with Tailwind's
// translate utilities, which in v4 set the standalone `translate` property. A
// `transform` of the same shape would not replace it, it would ADD to it, and the
// card would sit a full width and height away from where it belongs.
const CARD_STYLE = {
  width: 'min(50rem, 92vw)',
  maxWidth: '92vw',
  maxHeight: 'calc(100vh - 26rem)',
  top: '38%',
  translate: '-50% -50%'
}
// The dialog shell's own scrim stays: the app dims and blurs what is behind a
// dialog, and a card floating over a dimmed app is the look. What it must not do
// is take the POINTER, or the list the card came from would freeze and the walk
// between a row and the card would be one way only. `pointer-events-none` beats
// the shell's own `pointer-events-auto` in the class merge.
const OVERLAY_DIM = 'pointer-events-none'
// No cap and no scroll of its own: the dialog shell owns the height and its body
// box scrolls, so the card cannot grow past the cap above.
const CARD_SCROLL_STYLE = { display: 'flex', flexDirection: 'column', gap: '0.75rem' }
const PILL_ROW_STYLE = { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }
const COMMENT_STYLE = { display: 'flex', flexDirection: 'column', gap: '0.125rem' }
const MUTED_TEXT = { color: QUIET_COLOR, fontSize: '0.6875rem', lineHeight: 1.45 }
const TINY_LABEL = { color: LABEL_COLOR, fontSize: '0.625rem' }

// One entry per group, keyed by the backend's own group name: the chip's color
// and the list's dot color, so a red count opens a red-dotted list. The word
// lives in the list header, never on the chip. The strip declares them in the
// backend's GROUP_ORDER, which is the board's own column order; a test fails if
// the two drift.
const GROUPS = {
  blocked: { dot: RED, label: 'blocked', tone: 'bad' },
  waiting: { dot: AMBER, label: 'waiting', tone: 'warn' },
  running: { dot: GREEN, label: 'running', tone: 'good' },
  queued: { dot: LABEL_COLOR, label: 'queued', tone: 'muted' },
  scheduled: { dot: LABEL_COLOR, label: 'scheduled', tone: 'muted' },
  review: { dot: AMBER, label: 'review', tone: 'warn' },
  done_today: { dot: GREEN, label: 'done today', tone: 'good' }
}

const STATUS_TONE = { blocked: 'bad', cancelled: 'bad', done: 'good', running: 'good', review: 'warn' }

// How long to wait for the board switcher and its menu to appear.
const BOARD_SWITCH_TIMEOUT_MS = 2000

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Polls `read` until it returns something, or `timeoutMs` passes. */
async function until(read, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value || Date.now() >= end) return value || null
    await pause(60)
  }
}

/**
 * The Kanban page's board switcher: a menu button with the project glyph that is
 * not in the statusbar (the app's own counter there carries the same glyph).
 */
function boardSwitcherTrigger() {
  return (
    Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(
      node => !node.closest('[data-slot="statusbar"]') && node.querySelector('.codicon-project')
    ) ?? null
  )
}

function boardSwitcherLabel(trigger) {
  const named = trigger.querySelector('span.truncate')?.textContent
  const text = named ?? String(trigger.getAttribute('aria-label') ?? '').replace(/^[^:]*:\s*/, '')
  return String(text).trim().toLowerCase()
}

/** A menu row reads "Name" plus the board's card count; the name is what is left of the digits. */
function boardItemName(item) {
  return String(item.textContent ?? '').replace(/\s*\d+\s*$/, '').trim().toLowerCase()
}

/**
 * Make the Kanban page show the board a card lives on.
 *
 * The page keeps its selected board in state the plugin SDK cannot reach, so this
 * does what a person does: open the board switcher and pick the board by name.
 * It needs a pointer-down on the trigger (that is what the menu listens for), and
 * it checks its own work by reading the switcher's label afterwards. It never
 * throws and never blocks the card open: when the switcher or the board is not
 * found, the page stays where it was and the card loop below simply finds nothing.
 * The page is left on the board it switched to, as if the person had picked it.
 */
async function showBoardOf(card) {
  const names = [card?.board_name, card?.board]
    .map(name => String(name ?? '').trim().toLowerCase())
    .filter(Boolean)
  if (names.length === 0) return
  try {
    const trigger = await until(boardSwitcherTrigger, BOARD_SWITCH_TIMEOUT_MS)
    if (!trigger || names.includes(boardSwitcherLabel(trigger))) return
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true, ctrlKey: false, pointerType: 'mouse' })
    )
    const item = await until(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => names.includes(boardItemName(node))),
      BOARD_SWITCH_TIMEOUT_MS
    )
    if (!item) return
    item.click()
    // The page redraws on the new board before its cards can be clicked.
    await until(() => boardSwitcherLabel(boardSwitcherTrigger() ?? trigger) === boardItemName(item), BOARD_SWITCH_TIMEOUT_MS)
    await pause(150)
  } catch {
    // A page that does not look the way this expects leaves the board as the destination.
  }
}

/**
 * Open ONE card on the board, after landing there.
 *
 * The board offers no deep link for a single card: its drawer opens from local
 * state inside the page, a card carries no id in the DOM, and the plugin SDK has
 * no hook for it. So this does what a person does, and it checks its own work:
 * click a card whose text starts with the title, then look for the card's short id
 * on the page, which only its drawer shows. If the id is not there, try the next
 * candidate. That makes the many other draggable cards, and any chat message that
 * happens to quote the title, harmless: a wrong click costs one attempt and the
 * loop moves on.
 *
 * A card on another board first switches the page to that board (`showBoardOf`).
 * A card that cannot be found leaves the board as the destination, which is where
 * a plain click landed before this existed.
 */
function openCardOnBoard(card) {
  const title = String(card?.title ?? '').trim()
  const short = String(card?.id ?? '').replace(/^t_/, '').slice(0, 6)
  if (!title) return

  const isOpen = () => Boolean(short) && String(document.body.innerText ?? '').includes(short)
  const candidates = () =>
    Array.from(document.querySelectorAll('[draggable="true"]')).filter(
      node => node.dataset.hwmTried !== '1' && String(node.textContent ?? '').trim().startsWith(title)
    )

  const run = () => {
    const deadline = Date.now() + CARD_OPEN_TIMEOUT_MS
    const step = () => {
      if (isOpen()) return
      const next = candidates()[0]
      if (next) {
        next.dataset.hwmTried = '1'
        next.click()
      }
      if (Date.now() < deadline) setTimeout(step, 220)
    }
    setTimeout(step, 150)
  }

  // The card is only on the page once the page shows its board.
  showBoardOf(card).then(run, run)
}

// -- pure helpers -------------------------------------------------------------

function toCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** The groups the strip renders, as plain integers. */
function readGroups(data) {
  const source = data && typeof data.groups === 'object' && data.groups !== null ? data.groups : {}
  return {
    blocked: toCount(source.blocked),
    waiting: toCount(source.waiting),
    running: toCount(source.running),
    queued: toCount(source.queued),
    scheduled: toCount(source.scheduled),
    review: toCount(source.review),
    doneToday: toCount(source.done_today)
  }
}

/** Each counted board with its own groups, for the popover split. Names only, never cards. */
function readBoards(data) {
  const source = data && Array.isArray(data.boards) ? data.boards : []
  return source
    .filter(board => board && typeof board === 'object')
    .map(board => ({
      name: String(board.name || board.slug || '').slice(0, 32),
      groups: readGroups({ groups: board.groups })
    }))
}

function readUnreadable(data) {
  const source = data && Array.isArray(data.unreadable) ? data.unreadable : []
  return source.map(slug => String(slug).slice(0, 32))
}

/**
 * "By board: work 34, default 7" for one group, largest first, at most four
 * boards. Empty when only one board is counted or none holds a card in the
 * group, so a single-board setup reads exactly as before.
 */
function byBoard(boards, key) {
  if (boards.length < 2) return ''
  const parts = boards
    .map(board => ({ name: board.name, count: board.groups[key] }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count)
  if (parts.length === 0) return ''
  const shown = parts.slice(0, 4).map(entry => `${entry.name} ${entry.count}`)
  if (parts.length > 4) shown.push(`${parts.length - 4} more`)
  return `By board: ${shown.join(', ')}`
}

function readWorkers(data) {
  const source = data && typeof data.workers === 'object' && data.workers !== null ? data.workers : {}
  const active = toCount(source.active)
  const stalled = toCount(source.stalled)
  const looping = toCount(source.looping)
  // The dot color follows the worst live state, and the state the backend
  // reports wins. A malformed state still reads as active rather than blank.
  const state = source.state === 'loop' || source.state === 'stalled' ? source.state : 'active'
  return { active, stalled, looping, state }
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function stateColor(state) {
  return STATE_COLOR[state] ?? GREEN
}

function statusTone(status) {
  return STATUS_TONE[status] ?? 'muted'
}

/** The clock a card's age is measured from: start, finish, or filing. */
function cardStamp(card) {
  if (card.status === 'running') return card.started_at || card.created_at
  if (card.status === 'done' || card.status === 'archived') return card.completed_at || card.created_at
  return card.created_at
}

/** Compact age for a row's trailing meta. Empty when the board has no clock. */
function ageLabel(stamp, now) {
  const seconds = Math.floor(Number(now) - Number(stamp))
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** The same stamp with the wall clock in front of it, for a detail panel. */
function stampLabel(stamp, now) {
  const value = Number(stamp)
  if (!Number.isFinite(value) || value <= 0) return ''
  const age = ageLabel(value, now)
  const wall = new Date(value * 1000).toLocaleString()
  return age ? `${wall}  (${age})` : wall
}

function cardTitle(card) {
  const title = typeof card.title === 'string' ? card.title.trim() : ''
  return title || String(card.id ?? 'untitled')
}

/** Row meta: the board when several are counted, the card id, then its age. Any part can be missing. */
function cardMeta(card, now, multi = false) {
  const board = multi && typeof card.board_name === 'string' ? card.board_name : ''
  return [board, String(card.id ?? ''), ageLabel(cardStamp(card), now)].filter(Boolean).join('  ')
}

// -- data hooks ---------------------------------------------------------------

/**
 * Polls `path` at `intervalMs` through React Query on the cached backend path.
 * A failed poll turns the snapshot into `null` rather than leaving the last
 * successful numbers on screen, so the strip never shows stale counts. The
 * rejection stays contained here.
 */
function useSummary(ctx, path, intervalMs) {
  const query = useQuery({
    queryKey: [ID, path],
    queryFn: () => ctx.rest(path),
    refetchInterval: intervalMs,
    retry: false
  })

  // `isRefetchError` covers the background-refetch failure that keeps the
  // previous `data` around with `status: 'error'`.
  const failed = query.isError === true || query.isRefetchError === true
  return { data: failed ? null : query.data, error: failed }
}

/**
 * The cards behind one count. Fetched only while its list is open, so an idle
 * statusbar stays silent. A connection whose plugin backend predates the route
 * answers 404, which lands here as `error` and the list says so in one line
 * instead of showing a wrong or empty list.
 */
function useCards(ctx, group, enabled) {
  const query = useQuery({
    queryKey: [ID, 'cards', group],
    queryFn: () => ctx.rest(`/cards?group=${encodeURIComponent(group)}&limit=${CARD_LIMIT}`),
    enabled,
    retry: false,
    staleTime: 10_000
  })

  const failed = query.isError === true || query.isRefetchError === true
  return {
    cards: Array.isArray(query.data?.cards) ? query.data.cards : [],
    error: failed,
    loading: query.isPending === true,
    total: toCount(query.data?.total)
  }
}

/**
 * Warms one card's cached detail before anyone hovers it. The list is on screen
 * already, so this fetch hides behind reading the list, and the hover then
 * paints from cache instead of opening with a loading line. It is one small read
 * only route per row, on a local connection, and React Query holds each answer
 * for the same window the overlay would have used.
 */
function CardPrefetch({ ctx, id }) {
  useCardDetail(ctx, id, true)
  return null
}

/** One card in full, fetched only while it is the card on show. */
function useCardDetail(ctx, id, enabled) {
  const query = useQuery({
    queryKey: [ID, 'card', id],
    queryFn: () => ctx.rest(`/card?id=${encodeURIComponent(id)}`),
    enabled,
    retry: false,
    staleTime: 15_000
  })

  const failed = query.isError === true || query.isRefetchError === true
  const data = failed ? null : query.data
  return {
    attachments: data?.attachments ?? { count: 0, names: [] },
    board: data?.board ?? null,
    card: data?.card ?? null,
    comments: data?.comments ?? { count: 0, recent: [] },
    error: failed,
    loading: query.isPending === true,
    run: data?.run ?? null
  }
}

// -- the card overlay ---------------------------------------------------------

/**
 * The card's own text goes through the app's chat markdown renderer. A renderer
 * that cannot mount outside a transcript must not take the whole overlay down
 * with it, so the fallback is the raw text in the app's code block.
 */
class PreviewBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Section({ children, label }) {
  return jsxs('div', { style: SECTION_STYLE, children: [jsx(PanelSectionLabel, { children: label }), children] })
}

/** The card's own fields, in the order the drawer shows them. */
function metaRows(card, now) {
  const rows = []
  const push = (label, value) => {
    if (value === null || value === undefined || value === '' || value === 0) return
    rows.push({ label, value: String(value) })
  }

  push('assignee', card.assignee)
  push('created by', card.created_by)
  push('created', stampLabel(card.created_at, now))
  push('started', stampLabel(card.started_at, now))
  push('completed', stampLabel(card.completed_at, now))
  push('blocked', card.block_kind)
  push('re-blocked', card.block_recurrences ? `${card.block_recurrences} times` : '')
  push('failures', card.consecutive_failures ? `${card.consecutive_failures} in a row` : '')
  push('retries', card.max_retries)
  push('project', card.project_id)
  push('workspace', [card.workspace_kind, card.workspace_path].filter(Boolean).join('  '))
  push('branch', card.branch_name)
  push('model', [card.provider_override, card.model_override].filter(Boolean).join('  '))
  push('contract', card.completion_contract)
  return rows
}

function runBody(run, now) {
  const rows = []
  if (run.status || run.outcome) {
    rows.push({ label: 'outcome', value: [run.status, run.outcome].filter(Boolean).join('  ') })
  }
  if (run.profile) rows.push({ label: 'profile', value: String(run.profile) })
  if (run.started_at) rows.push({ label: 'ran', value: stampLabel(run.started_at, now) })
  if (run.ended_at) rows.push({ label: 'ended', value: stampLabel(run.ended_at, now) })

  return jsxs('div', {
    style: STACK_STYLE,
    children: [
      rows.length > 0 ? jsx(PanelMeta, { rows }) : null,
      run.summary ? jsx(PanelBlock, { children: run.summary }) : null,
      run.error ? jsx(PanelBlock, { children: run.error }) : null
    ].filter(Boolean)
  })
}

function commentsBody(comments) {
  return jsx('div', {
    style: STACK_STYLE,
    children: comments.recent.map((item, index) =>
      jsxs('div', {
        key: `${item.author}-${String(item.created_at ?? index)}`,
        style: COMMENT_STYLE,
        children: [
          jsx('span', { style: TINY_LABEL, children: item.author || 'someone' }),
          jsx('span', { style: MUTED_TEXT, children: item.body })
        ]
      })
    )
  })
}

/**
 * One card, whole, the way the board's drawer shows it: the title and its pills,
 * the fields, the description, the newest run, the recent comments and the
 * attachments. Read-only, and it says where the actions are instead of faking
 * them: a plugin cannot reach the Kanban plugin's own API.
 */
function CardPreview({ detail, multi, onOpen }) {
  if (!detail.card) {
    return jsx('div', {
      style: NOTE_STYLE,
      children: detail.error ? 'No card detail from this connection.' : 'Loading the card'
    })
  }

  const card = detail.card
  const now = Math.floor(Date.now() / 1000)
  const body = typeof card.body === 'string' ? card.body.trim() : ''

  const pills = [
    jsx(PanelPill, { key: 'status', tone: statusTone(card.status), children: String(card.status ?? '') }),
    multi && detail.board?.name
      ? jsx(PanelPill, { key: 'board', tone: 'muted', children: String(detail.board.name) })
      : null,
    card.priority ? jsx(PanelPill, { key: 'priority', tone: 'muted', children: `p${card.priority}` }) : null,
    card.goal_mode ? jsx(PanelPill, { key: 'goal', tone: 'muted', children: 'goal loop' }) : null
  ].filter(Boolean)

  // The app's own dialog header: a title and a description, so the shell reads
  // as a dialog to assistive tech the same way every other dialog here does.
  const sections = [
    jsxs('div', {
      key: 'head',
      style: STACK_STYLE,
      children: [
        jsx(DialogTitle, { children: cardTitle(card) }),
        jsxs('div', {
          style: PILL_ROW_STYLE,
          children: [
            jsx(DialogDescription, { children: `${String(card.id ?? '')}  in ${card.status ?? 'unknown'}` }),
            ...pills
          ]
        })
      ]
    })
  ]

  const rows = metaRows(card, now)
  if (rows.length > 0) sections.push(jsx(PanelMeta, { key: 'meta', rows }))

  if (body) {
    sections.push(
      jsx(Section, {
        key: 'body',
        label: 'description',
        children: jsx(PreviewBoundary, {
          fallback: jsx(PanelBlock, { children: body }),
          children: jsx(MessageTextContent, { media: false, text: body })
        })
      })
    )
  }

  if (card.result) {
    sections.push(jsx(Section, { key: 'result', label: 'result', children: jsx(PanelBlock, { children: card.result }) }))
  }

  if (card.last_failure_error) {
    sections.push(
      jsx(Section, { key: 'failure', label: 'last failure', children: jsx(PanelBlock, { children: card.last_failure_error }) })
    )
  }

  if (detail.run) {
    sections.push(jsx(Section, { key: 'run', label: 'latest run', children: runBody(detail.run, now) }))
  }

  if (detail.comments.count > 0) {
    sections.push(
      jsx(Section, {
        key: 'comments',
        label: `comments (${detail.comments.count})`,
        children: commentsBody(detail.comments)
      })
    )
  }

  if (detail.attachments.count > 0) {
    sections.push(
      jsx(Section, {
        key: 'attachments',
        label: `attachments (${detail.attachments.count})`,
        children: jsx('div', { style: MUTED_TEXT, children: detail.attachments.names.join(', ') })
      })
    )
  }

  return jsxs('div', {
    style: CARD_SCROLL_STYLE,
    children: [
      ...sections,
      jsx(DialogFooter, {
        key: 'footer',
        children: [
          jsx(Button, {
            onClick: () => onOpen(detail.card),
            size: 'sm',
            variant: 'outline',
            children: 'Open on the board'
          })
        ]
      })
    ]
  })
}

/**
 * The card on show, as a centered overlay over the app. It floats in the middle
 * of the screen rather than hanging off the row it came from, which is what
 * makes it a large fixed target the pointer can simply walk onto.
 *
 * The app's dialog shell ships with a full screen scrim, and this overlay keeps
 * it: the app behind is dimmed and blurred, which is what a floating card should
 * look like. The scrim does not take the pointer, so the list the card came from
 * stays live and the walk between a row and the card works both ways. The
 * overlay holds no focus either, so the composer keeps the caret while a card is
 * being read. Escape, a click outside, or the shell's own close button dismiss
 * it.
 */
function CardPanel({ ctx, card, multi, onOpen, onClose }) {
  const detail = useCardDetail(ctx, card, card !== null)

  return jsx(Dialog, {
    modal: false,
    onOpenChange: next => {
      if (!next) onClose()
    },
    open: card !== null,
    children: jsx(DialogContent, {
      // Read only, brief, and opened by a hover: it must never pull the caret
      // out of the composer.
      'data-hwm-layer': 'card',
      onOpenAutoFocus: event => event.preventDefault(),
      onPointerEnter: markInside,
      onPointerLeave: releaseCardNow,
      onPointerMove: markInside,
      overlayClassName: OVERLAY_DIM,
      style: CARD_STYLE,
      children: card === null ? null : jsx(CardPreview, { detail, multi, onOpen })
    })
  })
}

// -- the list -----------------------------------------------------------------

/**
 * One card row. Resting on it opens the card in the centered overlay, and the
 * overlay replaces the previous card rather than stacking, so sweeping the list
 * walks the overlay through each card.
 */
function CardRow({ card, group, multi, now, onOpen, slot }) {
  const spec = GROUPS[group] ?? GROUPS.queued
  const hover = useValue($hover)
  const active = hover !== null && hover.slot === slot && hover.card === card.id
  const dot = group === 'running' ? STATE_COLOR[card.worker_state] ?? spec.dot : spec.dot

  return jsx('div', {
    'data-hwm-card': String(card.id ?? ''),
    onPointerEnter: () => scheduleCard(slot, card.id),
    onPointerLeave: cancelScheduledCard,
    children: jsx(PanelListRow, {
      active,
      lead: jsx('span', { style: { ...DOT_STYLE, backgroundColor: dot } }),
      meta: cardMeta(card, now, multi),
      onSelect: () => onOpen(card),
      rowKey: String(card.id ?? cardTitle(card)),
      title: cardTitle(card)
    })
  })
}

function PopoverBody({ cards, ctx, error, group, loading, multi, now, onOpen, slot, total }) {
  if (error) {
    return jsx('div', { style: NOTE_STYLE, children: 'This connection has no card list yet.' })
  }

  if (cards.length === 0) {
    return jsx('div', { style: NOTE_STYLE, children: loading ? 'Loading cards' : 'No cards in this group.' })
  }

  // Every component here is RENDERED (`jsx(Type, props)`), never CALLED as a
  // plain function: a component that owns hooks must keep a stable hook order,
  // and the strip's group set changes from render to render.
  // Every card in this list is warmed in the same pass, before the pointer
  // reaches a row, so the overlay opens on a cache hit.
  const rows = cards.map(card => jsx(CardPrefetch, { ctx, id: card.id, key: `warm-${card.id}` }))
  rows.push(
    ...cards.map(card =>
      jsx(CardRow, { card, group, key: String(card.id ?? cardTitle(card)), multi, now, onOpen, slot })
    )
  )

  if (total > cards.length) {
    rows.push(
      jsx('div', { key: 'more', style: NOTE_STYLE, children: `${total - cards.length} more on the board` })
    )
  }

  return jsx('div', { style: LIST_BODY_STYLE, children: rows })
}

/**
 * A count chip that opens its cards on hover. The hover is shared, so only one
 * list and one card are ever up, and both stay up while the pointer is on them.
 * Focus opens the list too, so it is reachable from the keyboard.
 */
function CountWithCards({ ctx, count, group, icon, label, multi, slot, split, tone, showDot }) {
  const spec = GROUPS[group] ?? GROUPS.queued
  const hover = useValue($hover)
  const open = hover !== null && hover.slot === slot
  const { cards, error, loading, total } = useCards(ctx, group, open)

  const show = () => hoverSlot(slot)

  const openBoard = card => {
    closeHover()
    try {
      host.navigate(BOARD_PATH)
    } catch {
      // Bridge unavailable: never break the statusbar.
    }
    openCardOnBoard(card)
  }

  const children = []
  if (showDot) children.push(jsx('span', { className: 'shrink-0', style: { ...DOT_STYLE, backgroundColor: tone ?? GREEN } }))
  else if (icon) children.push(icon)
  children.push(jsx('span', { className: 'tabular-nums font-medium', style: { color: tone }, children: String(count) }))

  const trigger = jsx('button', {
    'aria-label': `${label ?? group}: ${plural(count, 'card')}`,
    className: ITEM_CLASS,
    'data-hwm-slot': slot,
    onBlur: releaseSlot,
    onClick: () => openBoard(),
    onFocus: show,
    onPointerEnter: show,
    onPointerLeave: releaseSlot,
    onPointerMove: markInside,
    style: ITEM_STYLE,
    type: 'button',
    children
  })

  const panel = jsx(PopoverContent, {
    align: 'end',
    // A hover panel must never take focus away from the composer.
    onOpenAutoFocus: event => event.preventDefault(),
    // HOLD, never take: the panel keeps itself open while the pointer is on it,
    // but it cannot pull the hover back from the chip the pointer moved to.
    onPointerEnter: markInside,
    onPointerLeave: releaseList,
    onPointerMove: markInside,
    'data-hwm-layer': 'list',
    side: 'top',
    sideOffset: 6,
    style: POPOVER_STYLE,
    children: jsxs('div', {
      style: COLUMN_STYLE,
      children: [
        jsxs('div', {
          className: 'mb-1 flex items-center justify-between gap-2 px-1',
          children: [
            jsx(PanelSectionLabel, { children: spec.label }),
            jsx(PanelPill, { tone: spec.tone, children: String(total || count) })
          ]
        }),
        split ? jsx('div', { key: 'split', style: NOTE_STYLE, children: split }) : null,
        jsx(PopoverBody, {
          cards,
          ctx,
          error,
          group,
          loading,
          multi,
          now: Math.floor(Date.now() / 1000),
          onOpen: openBoard,
          slot,
          total: total || count
        })
      ]
    })
  })

  return jsxs(Popover, {
    onOpenChange: next => {
      if (!next) closeHover()
    },
    open,
    children: [jsx(PopoverTrigger, { asChild: true, children: trigger }), open ? panel : null]
  })
}

// -- the footer item ----------------------------------------------------------

function WorkerStrip({ ctx }) {
  // A hover left behind by a hot reload or a disable would open a panel on the
  // next mount with no pointer over it.
  useEffect(() => () => closeHover(), [])

  const { data, error } = useSummary(ctx, '/summary', SUMMARY_INTERVAL_MS)
  const hover = useValue($hover)

  const groups = readGroups(data)
  const workers = readWorkers(data)
  const boards = readBoards(data)
  const unreadable = readUnreadable(data)
  // Board names appear in the popovers only when more than one board is counted.
  const multi = boards.length > 1

  if (error) {
    return jsx('span', {
      style: STRIP_STYLE,
      children: jsx('button', {
        'aria-label': 'Board counts unavailable',
        className: ITEM_CLASS,
        onClick: () => {
          try {
            host.navigate(BOARD_PATH)
          } catch {
            // Bridge unavailable: never break the statusbar.
          }
        },
        style: ITEM_STYLE,
        type: 'button',
        children: [
          jsx(icons.Users, { className: 'shrink-0 size-3.5', style: { color: LABEL_COLOR } }),
          jsx('span', { style: { color: LABEL_COLOR }, children: 'n/a' })
        ]
      })
    })
  }

  const items = []

  if (groups.queued > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'queued',
        slot: 'queued',
        ctx,
        count: groups.queued,
        group: 'queued',
        multi,
        split: byBoard(boards, 'queued'),
        icon: jsx(icons.CircleIcon, { className: 'shrink-0 size-3', style: { color: LABEL_COLOR } }),
        label: 'queued',
        tone: QUIET_COLOR
      })
    )
  }

  if (groups.scheduled > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'scheduled',
        slot: 'scheduled',
        ctx,
        count: groups.scheduled,
        group: 'scheduled',
        multi,
        split: byBoard(boards, 'scheduled'),
        icon: jsx(icons.Clock, { className: 'shrink-0 size-3', style: { color: LABEL_COLOR } }),
        label: 'scheduled',
        tone: QUIET_COLOR
      })
    )
  }

  if (groups.running > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'running',
        slot: 'running',
        ctx,
        count: groups.running,
        group: 'running',
        multi,
        split: byBoard(boards, 'running'),
        label: 'running',
        showDot: true,
        tone: stateColor(workers.state)
      })
    )
  }

  if (groups.blocked > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'blocked',
        slot: 'blocked',
        ctx,
        count: groups.blocked,
        group: 'blocked',
        multi,
        split: byBoard(boards, 'blocked'),
        icon: jsx(icons.AlertTriangle, { className: 'shrink-0 size-3.5' }),
        label: 'blocked',
        tone: RED
      })
    )
  }

  if (groups.waiting > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'waiting',
        slot: 'waiting',
        ctx,
        count: groups.waiting,
        group: 'waiting',
        multi,
        split: byBoard(boards, 'waiting'),
        icon: jsx(icons.Clock, { className: 'shrink-0 size-3.5', style: { color: QUIET_COLOR } }),
        label: 'waiting',
        tone: QUIET_COLOR
      })
    )
  }

  if (groups.review > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'review',
        slot: 'review',
        ctx,
        count: groups.review,
        group: 'review',
        multi,
        split: byBoard(boards, 'review'),
        icon: jsx(icons.Eye, { className: 'shrink-0 size-3', style: { color: LABEL_COLOR } }),
        label: 'review',
        tone: QUIET_COLOR
      })
    )
  }

  if (groups.doneToday > 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'done_today',
        slot: 'done_today',
        ctx,
        count: groups.doneToday,
        group: 'done_today',
        multi,
        split: byBoard(boards, 'doneToday'),
        icon: jsx(icons.CheckCircle2, { className: 'shrink-0 size-3', style: { color: LABEL_COLOR } }),
        label: 'done today',
        tone: QUIET_COLOR
      })
    )
  }

  // A board that could not be read is never shown as an empty one.
  if (unreadable.length > 0) {
    items.push(
      jsx('button', {
        'aria-label': `${plural(unreadable.length, 'board')} could not be read and is left out of the counts: ${unreadable.join(', ')}`,
        className: ITEM_CLASS,
        key: 'unreadable',
        onClick: () => {
          try {
            host.navigate(BOARD_PATH)
          } catch {
            // Bridge unavailable: never break the statusbar.
          }
        },
        style: ITEM_STYLE,
        title: `${plural(unreadable.length, 'board')} could not be read and is left out of the counts: ${unreadable.join(', ')}`,
        type: 'button',
        children: [
          jsx(icons.AlertTriangle, { className: 'shrink-0 size-3.5', key: 'icon', style: { color: AMBER } }),
          jsx('span', { className: 'tabular-nums font-medium', key: 'count', style: { color: AMBER }, children: String(unreadable.length) })
        ]
      })
    )
  }

  // The boards setting matched no board: say so instead of reading as an idle board.
  if (data && Array.isArray(data.boards) && data.boards.length === 0 && unreadable.length === 0) {
    items.push(
      jsx('button', {
        'aria-label': 'No board matches the boards setting of this plugin',
        className: ITEM_CLASS,
        key: 'no-board',
        style: ITEM_STYLE,
        title: 'No board matches the boards setting of this plugin',
        type: 'button',
        children: [
          jsx(icons.Users, { className: 'shrink-0 size-3.5', key: 'icon', style: { color: AMBER } }),
          jsx('span', { key: 'text', style: { color: AMBER }, children: 'no board' })
        ]
      })
    )
  }

  // An idle board still says something: the backlog, or nothing at all.
  if (items.length === 0) {
    items.push(
      jsx(CountWithCards, {
        key: 'idle',
        slot: 'idle',
        ctx,
        count: 0,
        group: 'queued',
        icon: jsx(icons.Users, { className: 'shrink-0 size-3.5', style: { color: LABEL_COLOR } }),
        label: 'idle',
        tone: LABEL_COLOR
      })
    )
  }

  // The strip decides which chip is hovered, from the pointer event. A chip
  // handler alone loses the race whenever a panel sits over a neighbouring chip:
  // the pointer never reaches that chip, so the old panel stays up.
  //
  // The card overlay rides along as a sibling: it is portalled to the page, so
  // it floats in the middle of the screen and never inherits the strip's layout.
  return jsxs('span', {
    'data-hwm-layer': 'strip',
    onPointerLeave: releaseSlot,
    onPointerMove: event => {
      const slot = slotUnder(event)
      if (slot) hoverSlot(slot)
      else markInside()
    },
    style: STRIP_STYLE,
    children: [
      ...items,
      jsx(CardPanel, {
        card: hover !== null ? hover.card : null,
        ctx,
        key: 'card-panel',
        multi,
        onClose: clearCard,
        onOpen: () => {
          closeHover()
          try {
            host.navigate(BOARD_PATH)
          } catch {
            // Bridge unavailable: never break the statusbar.
          }
        }
      })
    ]
  })
}

// -- plugin contract ----------------------------------------------------------

export default {
  id: ID, // must match the folder name / manifest name
  name: 'Hermes Worker Monitor',
  // On by default: the strip is the point of this plugin and it reads counts
  // only, so it should not need a switch flip to appear. The user can still
  // turn it off in Capabilities, Plugins.
  defaultEnabled: true,
  register(ctx) {
    hideCoreCounter()
    ctx.register({
      id: 'summary',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(WorkerStrip, { ctx })
    })
  }
}