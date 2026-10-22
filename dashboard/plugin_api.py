"""Hermes Worker Monitor dashboard API.

Three read-only routes. ``/summary`` is the one payload the footer strip reads:
the Kanban group counts and the health of the running workers. ``/cards``
returns the cards behind ONE group, for the popover a count opens. ``/card``
returns ONE card in full, for the preview a hovered card row opens. All three
cover every live Kanban board, or the boards the user chose in the plugin
settings, and open the local Kanban and worker session databases read-only. This fork reads no
credentials, makes no network calls, and writes nothing.

The card routes are the only ones that carry card text, and each answers for the
one group or the one card that was asked for: identifiers, titles, assignees, the
body of that single card, its newest run, and its recent comments. The database
is still the only place a card's arguments live. None of them is cached: they
answer a hover, and a list or a body stale enough to disagree with the live
count beside it reads as a fault.
"""

from __future__ import annotations

import asyncio
import importlib.util as _ilu
import inspect
import json
import os
import sqlite3
import time
from collections.abc import Mapping
from contextlib import closing
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query

try:
    from .workers import (
        DEPENDENCY_KINDS,
        GROUP_ORDER,
        QUEUED_STATUSES,
        build_summary_response,
        card_group,
        card_state,
        hash_arguments,
        normalize_groups,
    )
except ImportError:  # Loaded by file path by the Hermes plugin loader: no package, no sys.path entry.

    def _load_sibling(name: str) -> Any:
        spec = _ilu.spec_from_file_location(f"hermes_worker_monitor_{name}", Path(__file__).with_name(f"{name}.py"))
        module = _ilu.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    _workers = _load_sibling("workers")
    DEPENDENCY_KINDS = _workers.DEPENDENCY_KINDS
    GROUP_ORDER = _workers.GROUP_ORDER
    QUEUED_STATUSES = _workers.QUEUED_STATUSES
    build_summary_response = _workers.build_summary_response
    card_group = _workers.card_group
    card_state = _workers.card_state
    hash_arguments = _workers.hash_arguments
    normalize_groups = _workers.normalize_groups


router = APIRouter()
CACHE_TTL_S = 300

PLUGIN_ID = "hermes-worker-monitor"
DEFAULT_BOARD = "default"

# Assignee values that mean "the default profile", whose sessions live in the
# root store rather than under ``profiles/``.
_DEFAULT_PROFILE_NAMES = {"", "default"}


class TTLCache:
    def __init__(self, ttl: int = CACHE_TTL_S) -> None:
        self.ttl = ttl
        self._value: dict[str, Any] | None = None
        self._stored_at = 0.0

    def clear(self) -> None:
        self._value = None
        self._stored_at = 0.0

    def get(self, *, now: float) -> dict[str, Any] | None:
        if self._value is None or now - self._stored_at >= self.ttl:
            return None
        return self._value

    def set(self, value: dict[str, Any], *, now: float) -> dict[str, Any]:
        self._value = value
        self._stored_at = now
        return value


_summary_cache = TTLCache()
_summary_lock = asyncio.Lock()


def _readonly_connection(path: Path) -> sqlite3.Connection:
    resolved = path.expanduser().resolve(strict=True)
    return sqlite3.connect(f"file:{quote(str(resolved), safe='/')}?mode=ro", uri=True)


def _kanban_database() -> Path:
    return _hermes_home() / "kanban.db"


def _hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME")
    home = Path(configured).expanduser() if configured else Path.home() / ".hermes"
    # A named profile points HERMES_HOME at ``<root>/profiles/<name>`` while
    # kanban and the profile roster remain rooted at ``<root>``.
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


def _task_columns(connection: sqlite3.Connection) -> set[str]:
    """Column names of ``tasks``. Older boards have fewer than this one."""
    return {str(row[1]) for row in connection.execute("PRAGMA table_info(tasks)").fetchall()}


def _load_status_counts(path: Path | None = None) -> dict[str, int]:
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        rows = connection.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall()
    return {str(status): int(total) for status, total in rows}


def _load_blocked_kinds(path: Path | None = None) -> dict[str, int]:
    """Blocked cards by reason. An older board without the column has none."""
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        if "block_kind" not in _task_columns(connection):
            return {}
        rows = connection.execute(
            "SELECT COALESCE(block_kind, ''), COUNT(*) FROM tasks WHERE status = ? GROUP BY 1",
            ("blocked",),
        ).fetchall()
    return {str(kind): int(total) for kind, total in rows}


def _local_day_start(now: float | None = None) -> int:
    """Midnight, local time, as a Unix timestamp."""
    moment = time.localtime(time.time() if now is None else now)
    return int(time.mktime((moment.tm_year, moment.tm_mon, moment.tm_mday, 0, 0, 0,
                            moment.tm_wday, moment.tm_yday, moment.tm_isdst)))


def _load_done_today(now: float | None = None, path: Path | None = None) -> int:
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        if "completed_at" not in _task_columns(connection):
            return 0
        row = connection.execute(
            "SELECT COUNT(*) FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ?",
            (_local_day_start(now),),
        ).fetchone()
    return int(row[0]) if row else 0


def _load_running_tasks(path: Path | None = None) -> list[dict[str, Any]]:
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        available = {str(row[1]) for row in connection.execute("PRAGMA table_info(tasks)").fetchall()}
        # ``last_heartbeat_at`` is the dispatcher's own liveness signal, and the
        # board's health rule reads it (see workers.card_state). An older board
        # without the column still answers.
        wanted = [name for name in ("id", "assignee", "started_at", "last_heartbeat_at") if name in available]
        rows = connection.execute(
            f"SELECT {', '.join(wanted)} FROM tasks WHERE status = ? ORDER BY started_at, id",
            ("running",),
        ).fetchall()
    return [dict(zip(wanted, row)) for row in rows]


# -- which boards are counted ---------------------------------------------------

def _host_board_catalog() -> list[dict[str, Any]] | None:
    """The host's own board list (names, archived flag, pinned paths), or None.

    None means the host helpers are not importable, so the caller scans the
    board directories itself. Archived boards are never listed.
    """
    try:
        from hermes_cli import kanban_db, kanban_db_boards

        boards = []
        for meta in kanban_db_boards.list_boards(include_archived=False):
            slug = str(meta.get("slug") or "")
            if slug:
                boards.append({"slug": slug, "name": str(meta.get("name") or slug),
                               "path": Path(kanban_db.kanban_db_path(slug))})
        return boards or None
    except Exception:  # Any host change or import failure: fall back to the directory scan.
        return None


def _scan_boards() -> list[dict[str, Any]]:
    """Every live board found on disk: the default board, then ``kanban/boards/<slug>/``."""
    override = os.environ.get("HERMES_KANBAN_HOME", "").strip()
    root = Path(override).expanduser() if override else _hermes_home()
    boards = [{"slug": DEFAULT_BOARD, "name": "Default", "path": root / "kanban.db"}]
    directory = root / "kanban" / "boards"
    if directory.is_dir():
        for child in sorted(directory.iterdir(), key=lambda entry: entry.name.lower()):
            # ``_archived`` and dot directories are not boards.
            if child.name.startswith(("_", ".")) or not (child / "kanban.db").is_file():
                continue
            boards.append({"slug": child.name, "name": child.name, "path": child / "kanban.db"})
    return boards


def _selected_slugs() -> list[str] | None:
    """The board slugs the user chose in the plugin settings, or None for every board.

    Reads only this plugin's own ``plugins.entries.<id>.settings.boards`` entry.
    An empty list, a missing key and an unreadable config all mean every board.
    """
    try:
        from hermes_cli.config import load_config_readonly
        from hermes_cli.plugins_state import _plugin_settings_entry

        entry = _plugin_settings_entry(load_config_readonly() or {}, PLUGIN_ID)
    except Exception:
        return None
    settings = entry.get("settings") if entry is not None else None
    value = settings.get("boards") if isinstance(settings, Mapping) else None
    if isinstance(value, str):
        value = value.replace(",", " ").split()
    if not isinstance(value, (list, tuple)):
        return None
    slugs = [str(item).strip() for item in value if str(item).strip()]
    return slugs or None


def _active_boards() -> list[dict[str, Any]]:
    """The boards to count: the user's choice if there is one, else every live board."""
    boards = _host_board_catalog() or _scan_boards()
    chosen = _selected_slugs()
    if chosen is None:
        return boards
    wanted = set(chosen)
    return [board for board in boards if board["slug"] in wanted]


# -- one group's cards --------------------------------------------------------

# What a popover row needs. A column the board does not have is skipped, so an
# older board still answers.
_CARD_FIELDS = (
    "id",
    "title",
    "status",
    "assignee",
    "priority",
    "block_kind",
    "created_at",
    "started_at",
    "completed_at",
)

# Longest title sent. The popover draws one line, and the card body never leaves
# the database.
_TITLE_CAP = 200

# Statuses behind each status-shaped group. The other two groups are shaped by
# ``block_kind`` and by the day boundary instead.
_GROUP_STATUSES: dict[str, tuple[str, ...]] = {
    "running": ("running",),
    "queued": QUEUED_STATUSES,
    "scheduled": ("scheduled",),
    "review": ("review",),
}

# Per group, which card a person wants first: the longest run, then the newest
# finish. Everything else sorts by priority, then by age.
_GROUP_ORDER_BY = {
    "running": (("started_at", "ASC"),),
    "done_today": (("completed_at", "DESC"),),
}
_DEFAULT_ORDER_BY = (("priority", "DESC"), ("created_at", "ASC"))


def _order_clause(group: str, columns: set[str]) -> str:
    """ORDER BY for one group, built only from columns the board has."""
    pairs = _GROUP_ORDER_BY.get(group) or _DEFAULT_ORDER_BY
    parts = [f"{field} {direction}" for field, direction in pairs if field in columns]
    parts.append("id ASC")
    return ", ".join(parts)


def _group_where(group: str, columns: set[str], *, day_start: int) -> tuple[str, list[Any]]:
    """SQL that narrows the scan to a group's candidates.

    ``card_group`` still decides membership after the read, so a board that
    cannot tell the two blocked groups apart (no ``block_kind`` column) answers
    with an empty list rather than a wrong one.
    """
    if group in ("blocked", "waiting"):
        if "status" not in columns:
            return ("WHERE 0", [])
        if "block_kind" not in columns:
            return ("WHERE status = ?", ["blocked"]) if group == "blocked" else ("WHERE 0", [])
        marks = ", ".join("?" for _ in DEPENDENCY_KINDS)
        within = "IN" if group == "waiting" else "NOT IN"
        return (
            f"WHERE status = ? AND COALESCE(block_kind, '') {within} ({marks})",
            ["blocked", *DEPENDENCY_KINDS],
        )
    if group == "done_today":
        if "completed_at" not in columns:
            return ("WHERE 0", [])
        return ("WHERE completed_at IS NOT NULL AND completed_at >= ?", [day_start])
    statuses = _GROUP_STATUSES.get(group, ())
    if not statuses or "status" not in columns:
        return ("WHERE 0", [])
    marks = ", ".join("?" for _ in statuses)
    return (f"WHERE status IN ({marks})", list(statuses))


def _load_group_cards(group: str, limit: int, *, day_start: int, path: Path | None = None) -> list[dict[str, Any]]:
    """Up to ``limit`` cards of one group on one board, most relevant first."""
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        columns = _task_columns(connection)
        where, params = _group_where(group, columns, day_start=day_start)
        fields = [field for field in _CARD_FIELDS if field in columns]
        if not fields:
            return []
        rows = connection.execute(
            f"SELECT {', '.join(fields)} FROM tasks {where} ORDER BY {_order_clause(group, columns)} LIMIT ?",
            (*params, int(limit)),
        ).fetchall()

    cards: list[dict[str, Any]] = []
    for row in rows:
        card = dict(zip(fields, row))
        if card_group(
            status=str(card.get("status") or ""),
            block_kind=card.get("block_kind"),
            completed_at=card.get("completed_at"),
            day_start=day_start,
        ) != group:
            continue
        title = card.get("title")
        if isinstance(title, str) and len(title) > _TITLE_CAP:
            card["title"] = title[:_TITLE_CAP]
        cards.append(card)
    return cards


def _card_sort_key(group: str, card: dict[str, Any]) -> tuple:
    """The same order one board's query uses, applied across boards."""
    def number(field: str) -> float:
        value = card.get(field)
        return float(value) if isinstance(value, (int, float)) else 0.0

    if group == "running":
        return (number("started_at"), str(card.get("id") or ""))
    if group == "done_today":
        return (-number("completed_at"), str(card.get("id") or ""))
    return (-number("priority"), number("created_at"), str(card.get("id") or ""))


def _build_cards_payload(group: str, limit: int) -> dict[str, Any]:
    """One group's cards over the counted boards, plus that group's real total from
    the same fold the footer strip counts with, so a capped list never reads as
    the whole board. Each card names its board."""
    now = int(time.time())
    day_start = _local_day_start(now)
    cards: list[dict[str, Any]] = []
    total = 0
    unreadable: list[str] = []
    last_error: Exception | None = None
    boards = _active_boards()
    for board in boards:
        path = board["path"]
        try:
            found = _load_group_cards(group, limit, day_start=day_start, path=path)
            counted = normalize_groups(
                _load_status_counts(path), _load_blocked_kinds(path), done_today=_load_done_today(now, path)
            )
        except (sqlite3.Error, OSError) as error:
            unreadable.append(board["slug"])
            last_error = error
            continue
        total += int(counted.get(group) or 0)
        for card in found:
            card["board"] = board["slug"]
            card["board_name"] = board["name"]
        cards.extend(found)
    if boards and len(unreadable) == len(boards) and last_error is not None:
        raise last_error
    cards.sort(key=lambda card: _card_sort_key(group, card))
    cards = cards[: int(limit)]
    if group == "running":
        # The chip colors itself by the worst live worker, so each row carries
        # its own state instead of one flat color for the group.
        for card in cards:
            card["worker_state"] = card_state(_load_tool_events(card), now=now)
    payload = {
        "generated_at": now,
        "group": group,
        "limit": int(limit),
        "shown": len(cards),
        "total": total,
        "cards": cards,
    }
    if unreadable:
        payload["unreadable"] = unreadable
    return payload


# -- one card's detail --------------------------------------------------------

# Caps on the free text one preview may carry. The panel shows ONE card, so a
# whole body can ship; a runaway value cannot.
_BODY_CAP = 6000
_RESULT_CAP = 2000
_ERROR_CAP = 800
_COMMENT_CAP = 500
_RECENT_COMMENTS = 3
_ATTACHMENT_NAMES = 10

# What a preview draws, plus the fields it can do without.
_CARD_DETAIL_FIELDS = (
    "assignee",
    "block_kind",
    "block_recurrences",
    "body",
    "branch_name",
    "completed_at",
    "completion_contract",
    "consecutive_failures",
    "created_at",
    "created_by",
    "goal_mode",
    "id",
    "last_failure_error",
    "max_retries",
    "model_override",
    "priority",
    "project_id",
    "provider_override",
    "result",
    "session_id",
    "started_at",
    "status",
    "tenant",
    "title",
    "workspace_kind",
    "workspace_path",
)


def _clip(value: Any, cap: int) -> Any:
    """Trim long free text. The row keeps its type."""
    if isinstance(value, str) and len(value) > cap:
        return value[:cap]
    return value


def _table_names(connection: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _load_card_payload(card_id: str, path: Path | None = None) -> dict[str, Any] | None:
    """One card in full, plus its newest run, its recent comments and its
    attachments. The board's own drawer shows the same three, and a hovered row
    opens this instead of leaving the page."""
    with closing(_readonly_connection(path or _kanban_database())) as connection:
        tables = _table_names(connection)
        columns = _task_columns(connection)
        fields = [field for field in _CARD_DETAIL_FIELDS if field in columns]
        if "tasks" not in tables or not fields:
            return None

        row = connection.execute(
            f"SELECT {', '.join(fields)} FROM tasks WHERE id = ?",
            (card_id,),
        ).fetchone()
        if row is None:
            return None

        card = dict(zip(fields, row))
        card["body"] = _clip(card.get("body"), _BODY_CAP)
        card["result"] = _clip(card.get("result"), _RESULT_CAP)
        card["last_failure_error"] = _clip(card.get("last_failure_error"), _ERROR_CAP)

        run: dict[str, Any] | None = None
        if "task_runs" in tables:
            run_columns = {str(info[1]) for info in connection.execute("PRAGMA table_info(task_runs)")}
            run_fields = [
                name
                for name in ("status", "outcome", "profile", "started_at", "ended_at", "summary", "error")
                if name in run_columns
            ]
            if run_fields:
                run_row = connection.execute(
                    f"SELECT {', '.join(run_fields)} FROM task_runs WHERE task_id = ? "
                    "ORDER BY started_at DESC, id DESC LIMIT 1",
                    (card_id,),
                ).fetchone()
                if run_row is not None:
                    run = dict(zip(run_fields, run_row))
                    run["summary"] = _clip(run.get("summary"), _ERROR_CAP)
                    run["error"] = _clip(run.get("error"), _ERROR_CAP)

        comments: dict[str, Any] = {"count": 0, "recent": []}
        if "task_comments" in tables:
            comments["count"] = int(
                connection.execute("SELECT COUNT(*) FROM task_comments WHERE task_id = ?", (card_id,)).fetchone()[0]
            )
            recent = connection.execute(
                "SELECT author, body, created_at FROM task_comments WHERE task_id = ? "
                "ORDER BY created_at DESC, id DESC LIMIT ?",
                (card_id, _RECENT_COMMENTS),
            ).fetchall()
            comments["recent"] = [
                {"author": str(item[0] or ""), "body": _clip(item[1], _COMMENT_CAP), "created_at": item[2]}
                for item in reversed(recent)
            ]

        attachments: dict[str, Any] = {"count": 0, "names": []}
        if "task_attachments" in tables:
            attachments["count"] = int(
                connection.execute("SELECT COUNT(*) FROM task_attachments WHERE task_id = ?", (card_id,)).fetchone()[0]
            )
            attachments["names"] = [
                str(item[0])
                for item in connection.execute(
                    "SELECT filename FROM task_attachments WHERE task_id = ? ORDER BY created_at, id LIMIT ?",
                    (card_id, _ATTACHMENT_NAMES),
                ).fetchall()
            ]

    return {
        "generated_at": int(time.time()),
        "card": card,
        "run": run,
        "comments": comments,
        "attachments": attachments,
    }


def _find_card_payload(card_id: str) -> dict[str, Any] | None:
    """The card, found on the first counted board that holds it, tagged with that board.

    Card ids are random, so the same id on two boards is not expected. A board
    that cannot be read is skipped, like a board that has no such card.
    """
    for board in _active_boards():
        try:
            payload = _load_card_payload(card_id, board["path"])
        except (sqlite3.Error, OSError):
            continue
        if payload is not None:
            payload["board"] = {"slug": board["slug"], "name": board["name"]}
            return payload
    return None


def _profile_databases(assignee: str) -> list[Path]:
    """Candidate read-only stores for *assignee*, most specific first.

    A named profile keeps its sessions in ``profiles/<name>/state.db``. The
    default profile has no profile directory at all: its sessions live in the
    root ``<hermes home>/state.db``. Reading only the named path would leave
    every card of the default profile with no activity signal.
    """
    if not assignee or assignee in {".", ".."} or Path(assignee).name != assignee:
        return []
    root = _hermes_home()
    candidates: list[Path] = []
    profiles = (root / "profiles").resolve()
    named = (profiles / assignee / "state.db").resolve()
    if named.is_relative_to(profiles) and named.is_file():
        candidates.append(named)
    if assignee in _DEFAULT_PROFILE_NAMES:
        root_database = (root / "state.db").resolve()
        if root_database.is_relative_to(root.resolve()) and root_database.is_file():
            candidates.append(root_database)
    return candidates


def _extract_calls(tool_calls: Any, timestamp: float) -> list[dict[str, Any]]:
    if isinstance(tool_calls, str):
        try:
            tool_calls = json.loads(tool_calls)
        except (TypeError, ValueError):
            return []
    if not isinstance(tool_calls, list):
        return []
    events = []
    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else call
        name = function.get("name") or call.get("tool_name")
        if not name:
            continue
        events.append({"tool_name": str(name), "arguments_hash": hash_arguments(function.get("arguments", {})), "timestamp": timestamp})
    return events


def _events_from(database: Path, task: dict[str, Any]) -> list[dict[str, Any]]:
    started = float(task.get("started_at") or 0)
    with closing(_readonly_connection(database)) as connection:
        session = connection.execute(
            "SELECT id FROM sessions WHERE source = ? AND started_at >= ? ORDER BY ABS(started_at - ?) LIMIT 1",
            ("kanban", started - 60, started),
        ).fetchone()
        if session is None:
            return []
        rows = connection.execute(
            "SELECT tool_calls, timestamp FROM messages WHERE session_id = ? AND tool_calls IS NOT NULL "
            "AND active = 1 AND compacted = 0 ORDER BY timestamp DESC, id DESC LIMIT 200",
            (session[0],),
        ).fetchall()
    events: list[dict[str, Any]] = []
    for tool_calls, timestamp in reversed(rows):
        events.extend(_extract_calls(tool_calls, float(timestamp)))
    return events


def _load_tool_events(task: dict[str, Any]) -> list[dict[str, Any]]:
    for database in _profile_databases(str(task.get("assignee") or "")):
        events = _events_from(database, task)
        if events:
            return events
    return []


def _build_summary_payload() -> dict[str, Any]:
    now = int(time.time())
    totals = {key: 0 for key in GROUP_ORDER}
    per_board: list[dict[str, Any]] = []
    unreadable: list[str] = []
    tasks: list[dict[str, Any]] = []
    last_error: Exception | None = None
    boards = _active_boards()
    for board in boards:
        path = board["path"]
        try:
            counts = _load_status_counts(path)
            kinds = _load_blocked_kinds(path)
            done_today = _load_done_today(now, path)
            running = _load_running_tasks(path)
        except (sqlite3.Error, OSError) as error:
            # One unreadable board must not hide the others, and must not read as zero.
            unreadable.append(board["slug"])
            last_error = error
            continue
        groups = normalize_groups(counts, kinds, done_today=done_today)
        for key in totals:
            totals[key] += int(groups.get(key) or 0)
        per_board.append({"slug": board["slug"], "name": board["name"], "groups": groups})
        # Card ids are only unique within one board.
        tasks.extend({**task, "id": f"{board['slug']}:{task['id']}"} for task in running)
    if boards and not per_board and last_error is not None:
        raise last_error
    activity = {str(task["id"]): _load_tool_events(task) for task in tasks}
    return build_summary_response(tasks, activity, totals, now=now, boards=per_board, unreadable=unreadable)


async def _cached(cache: TTLCache, lock: asyncio.Lock, fresh: int, builder: Callable[[], Any]) -> dict[str, Any]:
    now = time.monotonic()
    if not fresh:
        cached = cache.get(now=now)
        if cached is not None:
            return cached
    async with lock:
        now = time.monotonic()
        if not fresh:
            cached = cache.get(now=now)
            if cached is not None:
                return cached
        value = builder()
        if inspect.isawaitable(value):
            value = await value
        return cache.set(value, now=time.monotonic())


@router.get("/summary")
async def get_summary(fresh: int = Query(default=0, ge=0, le=1)) -> dict[str, Any]:
    return await _cached(_summary_cache, _summary_lock, fresh, lambda: asyncio.to_thread(_build_summary_payload))


@router.get("/cards")
async def get_cards(
    group: str = Query(..., description="One of: " + ", ".join(GROUP_ORDER)),
    limit: int = Query(default=25, ge=1, le=50),
) -> dict[str, Any]:
    """The cards behind ONE group, for the popover the desktop half opens.

    Uncached on purpose: it answers a hover, and a list stale enough to disagree
    with the live count beside it reads as a fault.
    """
    if group not in GROUP_ORDER:
        raise HTTPException(status_code=400, detail=f"Unknown group: {group}")
    return await asyncio.to_thread(_build_cards_payload, group, limit)


@router.get("/card")
async def get_card(id: str = Query(..., min_length=1, max_length=200)) -> dict[str, Any]:
    """One card in full, for the preview a hovered card row opens.

    Also uncached: it answers a hover, and the drawer it stands in for would
    never show a stale body either.
    """
    payload = await asyncio.to_thread(_find_card_payload, id)
    if payload is None:
        raise HTTPException(status_code=404, detail="No such card")
    return payload
