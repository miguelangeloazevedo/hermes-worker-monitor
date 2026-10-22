# Changelog

## 0.3.0

- The counts, the card lists and the card preview now cover every live Kanban board instead of the `default` board only. Boards come from the host's own board list when it is available, and from a scan of `<root>/kanban/boards/` otherwise (honouring `HERMES_KANBAN_HOME`). Archived boards and the `_archived` and dot directories are skipped.
- New `boards` setting (`plugins.entries.hermes-worker-monitor.settings.boards`, declared in `config_schema` so it shows in the settings form): a list of board slugs to count. Empty or missing means every board. Unknown slugs are ignored. A list that matches no board counts nothing and the strip says `no board`.
- Each popover opens with the split by board, for example `By board: work 34, default 7`: the four biggest, then `N more`. It shows when more than one board is counted.
- Card rows start with their board's name and the card overlay carries a board pill, both only when more than one board is counted. `GET /cards` merges the boards in the group's own order, tags each card with `board` and `board_name`, and reports the real total across boards. `GET /card` searches the counted boards for the id and names the board it found it on.
- A board that cannot be opened is named in an amber `unreadable` item and left out of the counts. It is never read as empty. If no board can be read the route fails, as before.
- Card ids are only unique within a board, so worker health is keyed by board and card.
- The summary payload keeps its existing keys and gains `boards` (slug, name, per-board groups) and, only when needed, `unreadable`.
- Behaviour change: 0.2.x counted the `default` board only. Set `boards` to `["default"]` to keep that.
- Known limit: the Kanban page shows one board at a time and has no deep link, so a card on another board opens the board page and not its drawer until you switch the page to that board.
- Tests: 67. The new ones cover the scan, the override, the combined and per-board counts, selection, an empty selection, unreadable boards, the host list, the settings read, card-id collisions, and the card list and card preview across boards. Each rule was checked by breaking it once.

## 0.2.2

- Clicking a card in a list now opens THAT card, not just the board. The board has no deep link for a single card (its drawer opens from local state, a card carries no id in the DOM, and the SDK has no hook for it), so the strip does what a person does and then checks its own work: click a card whose text starts with the title, then look for the card's short id on the page, which only its drawer shows. A wrong click (the page has hundreds of draggable nodes, chat messages quoting titles among them) costs one attempt and the loop tries the next candidate. Measured live: a row clicked in a 19 row list opened that card's drawer within 1 second.
- Fixed: the running dot read amber for live workers. Staleness came from a tool call gap of five minutes, which cannot see inside a long tool or a long generation. It now reads the dispatcher heartbeat, the board's own signal and its two minute threshold, so the footer dot and the board cannot disagree.
- Hovering a count now opens a popover with the cards behind that number instead of a text tooltip. Each row carries the card's dot, title, id, and age, and the rows are the app's own `PanelListRow` with `PanelPill` and `PanelSectionLabel`, so the footer and the app's Kanban list cannot drift apart.
- The `Click for the board` sentence is gone, and the tooltip with it. A count that needed a whole sentence to explain itself was not carrying its weight.
- The popover header shows the group's real total, and a capped list says how many more are on the board. A long group never reads as the whole board.
- The `running` rows carry their own worker state, so a stalled or looping worker is visible inside a healthy group instead of one flat color.
- New backend route `GET /cards?group=<name>&limit=<n>`. It reuses the same classification as the counts (`card_group` in `workers.py`), so a number and the cards under it cannot disagree. A test asserts, for every group, that the list length equals the count beside it.
- Only the fields a row draws come back: id, title, status, assignee, priority, blocked reason, and the created, started, and completed timestamps. The card body and the tool arguments stay in the database, and titles are capped at 200 characters.
- `/cards` is uncached on purpose: it answers a hover, and a list stale enough to disagree with the live count beside it reads as a fault.
- A backend that predates the route answers 404, and the popover says so in one line instead of showing an empty list.
- Fixed before the release: the strip rendered its count chips by calling the component as a plain function, so React threw (minified error `#300`) the moment the group set changed and the footer item disappeared. The chips are rendered through `jsx(...)` now, and a test fails if a hook-owning component is called that way again.
- One panel at a time, and the chip under the pointer always wins it. Each chip used to hold its own open flag, so moving across the footer left a row of panels up; then the panel claimed the slot back whenever the pointer crossed it, so the group you had left stayed on screen. The slot is shared now, the strip decides it from the pointer, and a panel only ever holds its own. A test fails if a chip grows a private flag again.
- The chip is an icon and a count, nothing else, and the chips sit close together. The group's name moved into the panel header, where there is room for it.
- The strip now follows the board's own column order (triage, todo, scheduled, ready, running, blocked, review, done), so it reads backlog, scheduled, running, blocked and its dependency half, review, done today. The backend's `GROUP_ORDER` is the one order and a test fails if the strip drifts from it. Blocked is no longer first: the board does not put it first either, and the red count still calls it out where it sits.
- A leave under a STATIONARY pointer no longer closes anything. Rows arriving replace the element under the pointer, and the browser calls that a leave with no related target; a first cut of the instant exit made a panel vanish while it was being read. Both instant closers now check the pointer's own position first (every layer names itself with `data-hwm-layer`).
- The card is the surface on top again, and the two panels no longer overlap at all. The card is centred at 38 percent of the viewport and capped at `100vh` minus 26rem; the list is anchored above the statusbar and capped at 14rem of rows, so the card's bottom stays clear of the list's top on any screen size. Measured live in a 1253x1027 window: card 226,85 to 1026,696, list 110,841 to 462,994, no intersection, card at z 130 over the list at 125.
- Fixed: the card landed partly off screen. Its position was set with a `transform`, and Tailwind v4 centres the dialog shell with the standalone `translate` property, so the two ADDED rather than one replacing the other. It uses `translate` now.
- Fixed: clicking a card in the list did nothing. The centered card overlay was painted OVER the list's upper rows, and anything sitting over a row swallows that row's click, so the click landed on the card instead of the row that opens the board. Verified after the geometry change: all four rows read as the list owning the point, and a row click moves the app to `/kanban`.
- Leaving the list is now measured, not absolute. With a card on show the pointer may be on its way to that card, so the hover is held for the walk and the timer ends it if the pointer never arrives; with nothing on show the list leaves on a short 300ms beat instead of waiting out a trip nobody is taking.
- Leaving a card closes it at once: only the trip IN gets a grace, because a pointer crossing the screen is on its way there, and once a card has been read the pointer is done with it.
- The duplicate is gone. The app's own Kanban counter (the core plugin, order 80, a project glyph and the number of running plus ready cards) said the same thing beside the strip. A render style statusbar item is never listed in the bar's own show/hide menu, and a plugin cannot unregister another plugin's contribution, so the strip drops it with one scoped stylesheet rule: the statusbar, and only the item carrying the project glyph. Deleting `HIDE_CORE_COUNTER_CSS` brings the counter straight back.
- The divider mark is gone. With the board order there is no cluster left to divide, and a lone dash next to the app's own Kanban counter read as part of it.
- Fixed: the `done today` panel never listed its cards. The desktop half asked for the group `done`, and the backend knows only `done_today`, so it answered 400. A test now pins every chip's slot and group to a name the backend answers.
- The list and the card are reachable with the mouse. The pointer can travel from a chip onto the list and from a row onto the card, and the close timer is a heartbeat rather than a countdown, so a slow path cannot close what the pointer is heading for.
- The card is a centered overlay over the whole app, not a panel hanging off the row: a fixed, large target in the middle of the screen, drawn with the app's own dialog shell (title, description, footer and close button included). A panel that follows its row is a small moving target that can land off screen or behind the list, which made reaching it a race.
- A card opens after a 130ms rest on a row, so sweeping the list does not flash a full screen overlay at every row it crosses. The overlay replaces the previous card rather than stacking.
- The hover grace is 1000ms, because the journey from the list to the middle of the screen is the long one.
- The app's own dim and blur stay behind the card, and the list rides above that dim (z 125, between the backdrop's 120 and the card's 130) so the scrim never darkens the list the pointer is walking back to. The scrim does not take the pointer, so the list the card came from stays live.
- Every card in an open list is fetched before it is hovered, so the overlay paints from cache instead of opening with a loading line. It is one small read only route per row on a local connection, and it hides behind the moment the pointer spends reading the list.
- Fixed: the overlay opened as an empty box. Children were passed as the third argument of `jsx`/`jsxs`, which is the element KEY in React's automatic runtime, so every section was dropped without a word. A test now fails on any `jsx` call whose third argument is an array.
- New backend route `GET /card?id=<task id>`. It returns the one card that was asked for, its newest run, its three newest comments and its attachment names, with the free text capped. An unknown id answers 404, and a quoted id is data, never SQL.
- One hover drives both layers, so the card overlay and the list go up and down together, and the card follows the row under the pointer instead of piling up.
- Tests: 42.

## 0.2.1

- The desktop half is on by default (`defaultEnabled: true`). The strip is the point of the plugin and it reads counts only, so it no longer needs a switch flip before it appears. It can still be turned off in Capabilities, Plugins.
- README install steps updated: reopen the app and the strip is there.

## 0.2.0

- The footer item now shows the board instead of a running-card count. One strip with `blocked`, `waiting`, `running`, `queued`, `scheduled`, `review`, and `done today`; a group with no cards is left out.
- Cards that stopped and need a person are first and red. Cards blocked on another card read as `waiting`, since the board clears those on its own.
- Hover any count for the breakdown (`10 running: 8 active, 2 stalled. Click for the board`). The tooltip is the app's own tooltip component.
- Click any count to open the Kanban board page in the app through `host.navigate('/kanban')`. The dropdown menu, the per-card rows, and the external link are gone, so the desktop half is smaller and there is no second screen to read.
- The running label never changes width. Only the state dot changes color, so the strip does not jitter as workers stall or loop.
- The route is now `GET /summary`, and the payload carries counts only: the group counts plus the number of active, stalled, and looping workers. No card identifier, title, assignee, or tool argument leaves the backend.
- The backend reads the board with one connection per query and tolerates an older board: a `tasks` table without `block_kind` or `completed_at` reports zero rather than failing.
- Removed every em dash from the code, the docs, and the UI copy. A test fails if one comes back.
- Tests: 20.

## 0.1.1

- Activity lookup no longer assumes every assignee has a profile directory. The default profile keeps its sessions in the root `state.db`, so reading only `profiles/<assignee>/state.db` left every default-profile card with no activity signal, and stall and loop detection never fired. The reader now tries the named profile store first, then the root store for the default assignee. A named profile never falls back to another store.
- Two tests cover the fallback, the preference order, and the rejection of unsafe assignee names.

## 0.1.0

- Fork of hermes-monitor v0.2.2 (MIT, mr-3mm3), worker health only.
- Renamed to hermes-worker-monitor, with its own plugin.yaml, manifest, and desktop plugin id.
- Removed the Quotas footer item, the provider fan-out, the DeepSeek key lookup and balance call, the Anthropic OAuth refresh path, and the internal-function clone.
- The backend now has one route, `GET /workers`, and the module reads no credentials and makes no network calls.
- Trimmed the test suite to the worker tests, plus a guard test that fails if a credential or network reference returns to the backend module.
