"""Pure board-summary transformations for Hermes Worker Monitor.

Two jobs, both pure: read a worker's health out of its recent tool calls, and
fold raw Kanban status counts into the handful of groups the footer shows.
Nothing here touches a database, a credential, or the network.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any

# A worker whose dispatcher heartbeat is older than this is stalled. It is the
# BOARD's own rule and threshold (the amber arc on the kanban page goes stale at
# two minutes, and a card with no heartbeat at all is never called stale), so the
# footer dot and the board cannot disagree about a worker.
HEARTBEAT_STALE_S = 120

# Fallback stall rule for a board old enough to have no heartbeat column: no tool
# call for this long. It is a poorer signal, because it cannot see inside a tool
# that is still running or a long generation, so it is only used when the
# heartbeat is missing.
STALL_AFTER_S = 300

# The same tool with the same arguments this many times in a row is a loop.
LOOP_MINIMUM = 4

# Cards that have not started: the dispatcher can pick these up.
QUEUED_STATUSES = ("todo", "ready", "triage")

# Blocked on another card. The rest of the blocked column needs a person.
DEPENDENCY_KINDS = ("dependency",)

# The footer groups, in strip order. It follows the board's own column order
# (triage, todo, scheduled, ready, running, blocked, review, done), so the strip
# and the board read the same way from left to right: backlog first, then work,
# then the two states a person still has to look at, then the day's finished
# cards. ``queued`` covers the board's triage, todo and ready columns, and
# ``waiting`` is the blocked column's dependency half. ``done_today`` is a time
# window rather than a status, which is why it is named apart from the status
# columns.
GROUP_ORDER = ("queued", "scheduled", "running", "blocked", "waiting", "review", "done_today")

BOARD_PATH = "/kanban"


def hash_arguments(arguments: Any) -> str:
    """Return a stable, non-reversible identifier for tool arguments."""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (TypeError, ValueError):
            pass
    canonical = json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def is_repeated_tool_loop(events: Iterable[Mapping[str, Any]], minimum: int = LOOP_MINIMUM) -> bool:
    """Detect an identical run at the tail of the recent call sequence."""
    recent = list(events)
    if len(recent) < minimum:
        return False
    last = recent[-1]
    name = str(last.get("tool_name") or "")
    digest = str(last.get("arguments_hash") or "")
    if not name or not digest:
        return False
    signature = (name, digest)
    run_length = 0
    for event in reversed(recent):
        current = (str(event.get("tool_name") or ""), str(event.get("arguments_hash") or ""))
        if current != signature:
            break
        run_length += 1
    return run_length >= minimum


def card_state(
    events: Iterable[Mapping[str, Any]],
    *,
    now: int,
    heartbeat_at: float | None = None,
) -> str:
    """One card's health: loop beats stalled, stalled beats active.

    Staleness comes from the dispatcher's heartbeat, the same signal the board
    paints its amber arc from, so a long tool or a long generation is not mistaken
    for a dead worker. A card with no heartbeat at all reads as active: the board
    does not call that stale either, and the footer must not cry wolf for a gap in
    the data. The tool call gap is only a fallback, for a board with no heartbeat
    column.
    """
    ordered = sorted(events, key=lambda event: float(event.get("timestamp") or 0))
    if is_repeated_tool_loop(ordered):
        return "loop"
    if heartbeat_at is not None:
        return "stalled" if now - float(heartbeat_at) > HEARTBEAT_STALE_S else "active"
    if not ordered:
        return "active"
    last = float(ordered[-1].get("timestamp") or 0)
    return "stalled" if now - last > STALL_AFTER_S else "active"


def summarize_workers(
    tasks: Iterable[Mapping[str, Any]],
    activity_by_card: Mapping[str, Iterable[Mapping[str, Any]]],
    *,
    now: int,
) -> dict[str, Any]:
    """Count running cards by health, without exposing any card or its work."""
    counts = {"active": 0, "stalled": 0, "looping": 0}
    total = 0
    for task in tasks:
        card_id = str(task["id"])
        total += 1
        state = card_state(
            activity_by_card.get(card_id, ()),
            now=now,
            heartbeat_at=task.get("last_heartbeat_at"),
        )
        counts["looping" if state == "loop" else state] += 1
    # Worst state first: the strip colors itself from this.
    if counts["looping"]:
        worst = "loop"
    elif counts["stalled"]:
        worst = "stalled"
    else:
        worst = "active"
    return {"total": total, "active": counts["active"], "stalled": counts["stalled"],
            "looping": counts["looping"], "state": worst}


def normalize_groups(
    status_counts: Mapping[str, Any],
    blocked_kinds: Mapping[str, Any] | None = None,
    *,
    done_today: int = 0,
) -> dict[str, int]:
    """Fold raw Kanban status counts into the footer groups.

    ``blocked`` holds the cards that need a person. ``waiting`` holds the cards
    blocked on another card, which the board clears on its own.
    """
    def count(*statuses: str) -> int:
        return sum(int(status_counts.get(status) or 0) for status in statuses)

    kinds = blocked_kinds or {}
    waiting = sum(int(kinds.get(kind) or 0) for kind in DEPENDENCY_KINDS)
    blocked_total = count("blocked")
    return {
        "blocked": max(0, blocked_total - waiting),
        "waiting": waiting,
        "running": count("running"),
        "queued": count(*QUEUED_STATUSES),
        "scheduled": count("scheduled"),
        "review": count("review"),
        "done_today": max(0, int(done_today)),
    }


def card_group(
    *,
    status: str,
    block_kind: str | None = None,
    completed_at: int | None = None,
    day_start: int = 0,
) -> str | None:
    """The one footer group a card belongs to, or None when no group counts it.

    This is the single classification behind both the counts and the card list,
    so a number and the cards under it cannot disagree.
    """
    kind = str(block_kind or "")
    if status == "blocked":
        return "waiting" if kind in DEPENDENCY_KINDS else "blocked"
    if status == "running":
        return "running"
    if status in QUEUED_STATUSES:
        return "queued"
    if status == "scheduled":
        return "scheduled"
    if status == "review":
        return "review"
    if completed_at is not None and int(completed_at) >= int(day_start):
        return "done_today"
    return None


def build_summary_response(
    tasks: Iterable[Mapping[str, Any]],
    activity_by_card: Mapping[str, Iterable[Mapping[str, Any]]],
    groups: Mapping[str, Any],
    *,
    now: int,
    boards: Iterable[Mapping[str, Any]] | None = None,
    unreadable: Iterable[str] | None = None,
) -> dict[str, Any]:
    """The one payload the desktop half reads.

    ``groups`` is the sum over the boards counted. ``boards`` carries each
    board's own groups under its name, for the popover's split, and
    ``unreadable`` names the boards that could not be read, so the footer never
    reads a board it failed to open as an empty one. Both keys are left out
    when not given.
    """
    response: dict[str, Any] = {
        "generated_at": int(now),
        "board": {"path": BOARD_PATH},
        "groups": {key: int(value) for key, value in groups.items()},
        "workers": summarize_workers(tasks, activity_by_card, now=now),
    }
    if boards is not None:
        response["boards"] = [
            {
                "slug": str(board["slug"]),
                "name": str(board.get("name") or board["slug"]),
                "groups": {key: int(value) for key, value in board["groups"].items()},
            }
            for board in boards
        ]
    if unreadable:
        response["unreadable"] = [str(slug) for slug in unreadable]
    return response
