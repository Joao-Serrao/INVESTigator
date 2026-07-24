"""PyInstaller entry point for the bundled Investraton engine.

Two modes in one exe:
  * no args            -> start the local app server (the Tauri sidecar / standalone)
  * <cli args>         -> run the CLI (used by scheduled tasks, e.g. `run-schedule <id>`)

Built with --windowed, so neither mode ever opens a console window — scheduled
digests run silently in the background.
"""

import sys


def _redirect_logs_when_windowed():
    """A --windowed exe has no stdout/stderr; point them at a log file so neither
    mode (server or CLI/scheduled run) crashes on the first print/log call."""
    if not getattr(sys, "frozen", False):
        return
    try:
        from investraton.config import HOME, provision_home

        provision_home()
        f = open(HOME / "investraton.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = f
    except Exception:
        pass


def main():
    _redirect_logs_when_windowed()
    argv = sys.argv[1:]
    # Scheduled tasks historically passed "-m investraton run-schedule <id>"; accept
    # and strip that prefix so both old and new task definitions work.
    if argv[:2] == ["-m", "investraton"]:
        argv = argv[2:]
    if argv:
        from investraton.__main__ import main as cli_main
        raise SystemExit(cli_main(argv))
    from investraton.api import main as app_main
    app_main()


if __name__ == "__main__":
    main()
