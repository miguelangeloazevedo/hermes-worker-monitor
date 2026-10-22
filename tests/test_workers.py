import json
import unittest

from dashboard.workers import (
    GROUP_ORDER,
    build_summary_response,
    card_group,
    HEARTBEAT_STALE_S,
    card_state,
    hash_arguments,
    is_repeated_tool_loop,
    normalize_groups,
    summarize_workers,
)


NOW = 1_700_000_000


def event(name, arguments, timestamp):
    return {"tool_name": name, "arguments_hash": hash_arguments(arguments), "timestamp": timestamp}


def test_detects_four_identical_consecutive_tool_calls():
    events = [event("read_file", {"path": "a"}, NOW - offset) for offset in (4, 3, 2, 1)]
    assert is_repeated_tool_loop(events)


def test_different_arguments_or_intervening_tool_is_not_loop():
    different_args = [event("read_file", {"path": str(i)}, NOW - i) for i in range(4)]
    interrupted = [
        event("read_file", {"path": "a"}, NOW - 4),
        event("read_file", {"path": "a"}, NOW - 3),
        event("write_file", {"path": "a"}, NOW - 2),
        event("read_file", {"path": "a"}, NOW - 1),
    ]
    assert not is_repeated_tool_loop(different_args)
    assert not is_repeated_tool_loop(interrupted)


def test_completed_historical_run_does_not_keep_worker_in_loop():
    events = [event("read_file", {"path": "a"}, NOW - offset) for offset in (5, 4, 3, 2)]
    events.append(event("terminal", {"command": "recovered"}, NOW - 1))
    assert not is_repeated_tool_loop(events)


def test_card_state_loop_beats_stalled_and_stall_threshold_is_a_boundary():
    repeated = [event("terminal", {"command": "safe"}, NOW - i) for i in range(4, 0, -1)]
    assert card_state(repeated, now=NOW) == "loop"
    # A stale loop is still a loop: the worker is stuck on the same call.
    assert card_state(repeated, now=NOW + 3600) == "loop"
    assert card_state([event("terminal", {}, NOW - 300)], now=NOW) == "active"
    assert card_state([event("terminal", {}, NOW - 301)], now=NOW) == "stalled"
    # No activity signal at all is a gap in the data, not a fault.
    assert card_state([], now=NOW) == "active"


def test_card_state_reads_the_board_heartbeat_not_a_tool_gap():
    """The dot follows the board's own rule: the dispatcher heartbeat, 2 minutes.

    Tool calls are a poorer signal. A worker halfway through a long build, or a
    long generation, has made no tool call for minutes while being perfectly
    alive, and a first cut of this painted the running count amber for it.
    """
    fresh = [event("terminal", {}, NOW - 900)]
    # A fresh heartbeat outvotes a stale looking tool gap.
    assert card_state(fresh, now=NOW, heartbeat_at=NOW - 30) == "active"
    # And a stale heartbeat is stale, whatever the tool log says.
    assert card_state([event("terminal", {}, NOW - 5)], now=NOW, heartbeat_at=NOW - 121) == "stalled"
    # The threshold is the board's own: 2 minutes, a boundary either way.
    assert card_state([], now=NOW, heartbeat_at=NOW - 120) == "active"
    assert card_state([], now=NOW, heartbeat_at=NOW - 121) == "stalled"
    # A missing heartbeat is not a fault: the board does not call that stale.
    assert card_state([], now=NOW, heartbeat_at=None) == "active"
    # A loop still beats a healthy heartbeat.
    repeated = [event("terminal", {"command": "ls"}, NOW - index) for index in range(4)]
    assert card_state(repeated, now=NOW, heartbeat_at=NOW) == "loop"
    # Without a heartbeat column, the old tool gap rule still answers.
    assert card_state([event("terminal", {}, NOW - 301)], now=NOW) == "stalled"
    assert HEARTBEAT_STALE_S == 120


def test_summary_counts_workers_by_state_and_reports_the_worst():
    tasks = [{"id": "t_loop"}, {"id": "t_edge"}, {"id": "t_stall"}, {"id": "t_quiet"}]
    repeated = [event("terminal", {"command": "safe"}, NOW - i) for i in range(4, 0, -1)]
    activity = {
        "t_loop": repeated,
        "t_edge": [event("terminal", {}, NOW - 300)],
        "t_stall": [event("terminal", {}, NOW - 301)],
    }

    result = summarize_workers(tasks, activity, now=NOW)

    assert result == {"total": 4, "active": 2, "stalled": 1, "looping": 1, "state": "loop"}
    assert "safe" not in json.dumps(result)


def test_summary_state_falls_back_to_stalled_then_active():
    tasks = [{"id": "a"}, {"id": "b"}]
    activity = {"a": [event("terminal", {}, NOW - 301)], "b": [event("terminal", {}, NOW)]}
    assert summarize_workers(tasks, activity, now=NOW)["state"] == "stalled"
    assert summarize_workers([], {}, now=NOW) == {
        "total": 0, "active": 0, "stalled": 0, "looping": 0, "state": "active"
    }


def test_groups_map_board_statuses_to_footer_counts():
    counts = {"triage": 2, "todo": 15, "ready": 4, "running": 10, "scheduled": 2,
              "review": 1, "blocked": 3, "done": 299, "archived": 8}
    kinds = {"capability": 1, "dependency": 2}

    groups = normalize_groups(counts, kinds, done_today=26)

    assert groups == {
        "blocked": 1, "waiting": 2, "running": 10, "queued": 21,
        "scheduled": 2, "review": 1, "done_today": 26,
    }


def test_groups_ignore_unknown_statuses_and_missing_kinds():
    groups = normalize_groups({"running": 3, "something-new": 9}, None, done_today=-5)
    assert groups == {
        "blocked": 0, "waiting": 0, "running": 3, "queued": 0,
        "scheduled": 0, "review": 0, "done_today": 0,
    }


def test_response_shape_is_counts_only():
    groups = normalize_groups({"running": 1, "blocked": 1}, {"capability": 1}, done_today=2)
    result = build_summary_response(
        [{"id": "t_1", "assignee": "default"}], {"t_1": [event("terminal", {}, NOW)]}, groups, now=NOW
    )

    assert set(result) == {"generated_at", "board", "groups", "workers"}
    assert result["board"] == {"path": "/kanban"}
    assert result["generated_at"] == NOW
    assert set(result["workers"]) == {"total", "active", "stalled", "looping", "state"}
    # No card identifier, title, or assignee reaches the desktop half.
    assert "t_1" not in json.dumps(result)
    assert "default" not in json.dumps(result)


def test_card_group_is_the_single_classification_behind_the_counts():
    assert card_group(status="blocked", block_kind="capability") == "blocked"
    assert card_group(status="blocked", block_kind="dependency") == "waiting"
    # A blocked card with no typed reason needs a person.
    assert card_group(status="blocked") == "blocked"
    assert card_group(status="running") == "running"
    for status in ("todo", "ready", "triage"):
        assert card_group(status=status) == "queued"
    assert card_group(status="scheduled") == "scheduled"
    assert card_group(status="review") == "review"


def test_card_group_done_today_is_a_time_window_not_a_status():
    assert card_group(status="done", completed_at=NOW, day_start=NOW) == "done_today"
    assert card_group(status="archived", completed_at=NOW + 1, day_start=NOW) == "done_today"
    assert card_group(status="done", completed_at=NOW - 1, day_start=NOW) is None
    assert card_group(status="done") is None
    # A live status wins over the day window: one card cannot be both finished
    # today and running now.
    assert card_group(status="running", completed_at=NOW + 1, day_start=NOW) == "running"


def test_every_group_the_strip_draws_is_reachable_by_the_classification():
    seen = {
        card_group(status="blocked", block_kind="capability"),
        card_group(status="blocked", block_kind="dependency"),
        card_group(status="running"),
        card_group(status="todo"),
        card_group(status="scheduled"),
        card_group(status="review"),
        card_group(status="done", completed_at=NOW, day_start=NOW),
    }
    assert seen == set(GROUP_ORDER)


def test_response_adds_board_names_and_unreadable_only_when_given():
    groups = normalize_groups({"running": 1, "blocked": 2}, {}, done_today=0)
    plain = build_summary_response([], {}, groups, now=NOW)
    assert "boards" not in plain and "unreadable" not in plain

    result = build_summary_response(
        [], {}, groups, now=NOW,
        boards=[{"slug": "alpha", "name": "Alpha team", "groups": groups}],
        unreadable=["beta"],
    )
    assert result["boards"] == [{"slug": "alpha", "name": "Alpha team", "groups": dict(groups)}]
    assert result["unreadable"] == ["beta"]


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for name, value in globals().items():
        if name.startswith("test_") and callable(value):
            suite.addTest(unittest.FunctionTestCase(value, description=name))
    return suite
