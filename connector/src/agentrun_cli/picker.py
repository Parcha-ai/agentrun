"""Terminal consent for observing existing local sessions."""

import sys
from collections import Counter

from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.data_structures import Point
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import HSplit, Layout, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.processors import BeforeInput
from prompt_toolkit.styles import Style
from prompt_toolkit.utils import is_dumb_terminal

from .network import MAX_SELECTIONS


def supported():
    return sys.stdin.isatty() and sys.stdout.isatty() and not is_dumb_terminal()


def choose_sessions(candidates):
    selected = set()
    future_projects = set()
    future_harnesses = set()
    page = "harness"
    harness = project = None
    cursor = 0
    previous = None
    names = {"claude": "Claude Code", "codex": "Codex"}
    project_labels = {c.project_id: c.project_label for c in candidates}
    query = Buffer(multiline=False)

    def selection_count():
        return len(selected) + len(future_projects) + len(future_harnesses)

    def matching_sessions():
        if page == "projects":
            return [
                c
                for c in candidates
                if c.harness == harness
                and query.text.casefold() in f"{c.project_label} · {c.project_id[:6]}".casefold()
            ]
        if page == "sessions":
            return [c for c in candidates if c.project_id == project and query.text.casefold() in c.label.casefold()]
        return [c for c in candidates if query.text.casefold() in names[c.harness].casefold()]

    def rows():
        scope = matching_sessions()
        if page == "harness":
            counts = Counter(c.harness for c in scope)
            checked = Counter(c.harness for c in scope if c.id in selected)
            items = [
                ("harness", name, f"{names[name]} · {counts[name]} sessions · {checked[name]} selected")
                for name in sorted(counts)
            ]
        elif page == "projects":
            projects = {c.project_id: c.project_label for c in scope}
            counts = Counter(c.project_id for c in scope)
            checked = Counter(c.project_id for c in scope if c.id in selected)
            items = [
                ("project", key, f"{label} · {key[:6]} · {counts[key]} sessions · {checked[key]} selected")
                for key, label in sorted(projects.items(), key=lambda item: item[1])
            ]
        elif page == "sessions":
            items = [("session", c.id, c.label) for c in scope]
        else:
            if not selection_count():
                action = ("empty", "", "Select at least one session or future subscription")
            elif selection_count() > MAX_SELECTIONS:
                action = ("empty", "", f"{selection_count():,} selections exceed the {MAX_SELECTIONS:,} limit")
            else:
                action = ("continue", "", "Continue to metadata confirmation")
            details = [
                (
                    "empty",
                    "",
                    f"{names[name]}: {sum(c.id in selected and c.harness == name for c in candidates)} existing sessions",
                )
                for name in sorted({c.harness for c in candidates})
            ]
            details += [
                ("empty", "", f"Future project sessions: {project_labels[key]} · {key[:6]}")
                for key in sorted(future_projects)
            ]
            details += [
                ("empty", "", f"Future {names[name]} sessions: all projects") for name in sorted(future_harnesses)
            ]
            return [action, ("back", "", "Back to selection"), *details]
        qualifier = "filtered " if query.text else ""
        actions = [
            ("all", "", f"Select all {qualifier}existing sessions ({len(scope)})"),
            ("clear", "", f"Clear {qualifier}existing sessions ({sum(c.id in selected for c in scope)} selected)"),
        ]
        if page == "projects":
            actions.append(("future_harness", harness, "Include future sessions across this harness (all projects)"))
        elif page == "sessions":
            actions.append(("future_project", project, "Include future sessions in this project"))
        return (items or [("empty", "", "No matching sessions or groups")]) + actions

    def header():
        future_count = len(future_projects) + len(future_harnesses)
        title = {
            "harness": "Choose harness",
            "projects": "Projects",
            "sessions": "Select sessions",
            "review": "Review connection",
        }[page]
        location = "Harnesses"
        if page in {"projects", "sessions"}:
            location += " / " + names[harness]
        if page == "sessions":
            location += " / " + project_labels[project]
        return [
            ("class:brand", "  AGENTRUN  /  Connect sessions\n"),
            ("class:muted", "  " + location + "\n\n"),
            ("class:title", "  " + title + "\n"),
            (
                "class:muted",
                f"  {len(selected)} existing session(s) selected · {future_count} future subscription(s)\n",
            ),
            ("class:muted", "  Nothing is shared until confirmation\n\n"),
        ]

    def content():
        fragments = []
        for index, (kind, key, label) in enumerate(rows()):
            checked = {"session": selected, "future_project": future_projects, "future_harness": future_harnesses}.get(
                kind
            )
            marker = ("[x] " if key in checked else "[ ] ") if checked is not None else "› "
            fragments.append(
                ("class:highlight" if index == cursor else "", f"  {'❯' if index == cursor else ' '} {marker}{label}\n")
            )
        return fragments

    keys = KeyBindings()

    def filter_changed(buffer):
        nonlocal cursor
        cursor = 0

    query.on_text_changed += filter_changed

    @keys.add("/")
    def search(event):
        if page != "review":
            event.app.layout.focus(search_control)

    @keys.add("a")
    def select_all(event):
        if page != "review":
            selected.update(c.id for c in matching_sessions())

    @keys.add("x")
    def clear_all(event):
        if page != "review":
            selected.difference_update(c.id for c in matching_sessions())

    @keys.add("up")
    def up(event):
        nonlocal cursor
        cursor = (cursor - 1) % len(rows())

    @keys.add("down")
    def down(event):
        nonlocal cursor
        cursor = (cursor + 1) % len(rows())

    @keys.add("home")
    def first(event):
        nonlocal cursor
        cursor = 0

    @keys.add("end")
    def last(event):
        nonlocal cursor
        cursor = len(rows()) - 1

    @keys.add("escape")
    @keys.add("left")
    def back(event):
        nonlocal page, cursor
        if page == "review":
            page = previous
        elif page == "sessions":
            page = "projects"
        elif page == "projects":
            page = "harness"
        else:
            event.app.exit(result=None)
        query.text = ""
        cursor = 0

    @keys.add("tab")
    def review(event):
        nonlocal page, previous, cursor
        if page != "review":
            previous, page, cursor = page, "review", 0
            query.text = ""

    @keys.add("enter")
    @keys.add(" ")
    def activate(event):
        nonlocal page, harness, project, cursor
        kind, key, _ = rows()[cursor]
        if kind == "session":
            selected.symmetric_difference_update({key})
        elif kind == "future_project":
            future_projects.symmetric_difference_update({key})
        elif kind == "future_harness":
            future_harnesses.symmetric_difference_update({key})
        elif kind == "harness":
            harness, page, cursor = key, "projects", 0
            query.text = ""
        elif kind == "project":
            project, page, cursor = key, "sessions", 0
            query.text = ""
        elif kind == "back":
            back(event)
        elif kind == "all":
            select_all(event)
        elif kind == "clear":
            clear_all(event)
        elif kind == "continue" and 1 <= selection_count() <= MAX_SELECTIONS:
            event.app.exit(result=(sorted(selected), sorted(future_projects), sorted(future_harnesses)))

    global_keys = KeyBindings()

    @global_keys.add("c-c")
    @global_keys.add("c-d")
    def cancel(event):
        event.app.exit(result=None)

    search_keys = KeyBindings()

    @search_keys.add("enter")
    def search_done(event):
        event.app.layout.focus(control)

    @search_keys.add("escape")
    def search_cancel(event):
        query.text = ""
        event.app.layout.focus(control)

    search_control = BufferControl(query, key_bindings=search_keys, input_processors=[BeforeInput("  Filter: ")])
    control = FormattedTextControl(
        content, focusable=True, key_bindings=keys, get_cursor_position=lambda: Point(0, cursor)
    )
    app = Application(
        layout=Layout(
            HSplit(
                [
                    Window(FormattedTextControl(header), height=8),
                    Window(search_control, height=1),
                    Window(control),
                    Window(
                        FormattedTextControl(
                            "  ↑↓ Move · Enter Open · Space Select · / Search · a All · x Clear\n"
                            "  ←/Esc Back · Tab Review · Ctrl-C Cancel"
                        ),
                        height=2,
                    ),
                ]
            ),
            focused_element=control,
        ),
        key_bindings=global_keys,
        full_screen=True,
        style=Style.from_dict(
            {
                "brand": "bold ansicyan",
                "title": "bold",
                "muted": "ansibrightblack",
                "highlight": "bg:ansicyan ansiblack bold",
            }
        ),
    )
    return app.run()
