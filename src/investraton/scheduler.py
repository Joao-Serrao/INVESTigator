"""Automatic digests via multiple named schedules.

Each schedule is a saved recipe (frequency + complexity + focus + delivery). They
live in config/schedules.json. `run_schedule()` executes one immediately. On
Windows, `sync_windows_tasks()` registers each enabled schedule with Task
Scheduler (schtasks) so digests fire even when the app is closed.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import tempfile
import uuid
from datetime import date
from pathlib import Path

from .config import CONFIG_DIR

log = logging.getLogger(__name__)

SCHEDULES_JSON = CONFIG_DIR / "schedules.json"
TASK_PREFIX = "Investraton"

FREQUENCIES = ["daily", "every_3_days", "weekly", "monthly"]
COMPLEXITIES = ["simple", "standard", "complex", "urgent", "none"]

# Stops schtasks (a console program) from flashing a console window when the
# windowed app spawns it during save/sync.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform.startswith("win") else 0


def load_schedules() -> list[dict]:
    if not SCHEDULES_JSON.exists():
        return []
    try:
        return json.loads(SCHEDULES_JSON.read_text(encoding="utf-8")) or []
    except Exception:  # noqa: BLE001
        return []


def save_schedules(items: list[dict]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SCHEDULES_JSON.write_text(json.dumps(items, indent=2), encoding="utf-8")


def upsert_schedule(sched: dict) -> dict:
    items = load_schedules()
    sched = _normalise(sched)
    if not sched.get("id"):
        sched["id"] = uuid.uuid4().hex[:12]
        items.append(sched)
    else:
        items = [sched if s.get("id") == sched["id"] else s for s in items]
        if not any(s.get("id") == sched["id"] for s in items):
            items.append(sched)
    save_schedules(items)
    return sched


def delete_schedule(sched_id: str) -> None:
    save_schedules([s for s in load_schedules() if s.get("id") != sched_id])


def _normalise(s: dict) -> dict:
    freq = s.get("frequency", "weekly")
    return {
        "id": s.get("id", ""),
        "name": s.get("name", "Digest"),
        "frequency": freq if freq in FREQUENCIES else "weekly",
        "time": s.get("time", "08:00"),
        "complexity": s.get("complexity", "standard") if s.get("complexity") in COMPLEXITIES else "standard",
        "focus": s.get("focus", "all"),
        "delivery": s.get("delivery") or [],
        "skip_if_empty": bool(s.get("skip_if_empty", False)),
        "enabled": bool(s.get("enabled", True)),
    }


def run_schedule(sched_id: str, deliver: bool = True):
    """Run one schedule now (used by the Task Scheduler task and the 'Run now' button)."""
    from .pipeline import run_digest

    sched = next((s for s in load_schedules() if s.get("id") == sched_id), None)
    if sched is None:
        raise ValueError(f"No schedule with id {sched_id}")
    return run_digest(
        period=sched["frequency"],
        deliver_output=deliver,
        focus=sched.get("focus", "all"),
        complexity=sched.get("complexity", "standard"),
        delivery_override=sched.get("delivery") or None,
        skip_if_empty=sched.get("skip_if_empty", False),
    )


# ---------- Windows Task Scheduler integration ----------
_MONTHS = ("January February March April May June July August September October "
           "November December").split()


def _xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _trigger_xml(sched: dict) -> str:
    f = sched["frequency"]
    if f == "daily":
        sb = "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"
    elif f == "every_3_days":
        sb = "<ScheduleByDay><DaysInterval>3</DaysInterval></ScheduleByDay>"
    elif f == "monthly":
        months = "".join(f"<{m}/>" for m in _MONTHS)
        sb = f"<ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth><Months>{months}</Months></ScheduleByMonth>"
    else:  # weekly
        sb = "<ScheduleByWeek><DaysOfWeek><Monday/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>"
    start = f"{date.today().isoformat()}T{sched.get('time', '08:00')}:00"
    return f"<CalendarTrigger><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled>{sb}</CalendarTrigger>"


def _run_command(sched_id: str) -> tuple[str, str]:
    """(executable, arguments) the scheduled task runs — never opens a console.

    Installed app: the bundled (windowed) exe in run-schedule mode.
    Dev: pythonw.exe (the no-console Python) running the module.
    """
    if getattr(sys, "frozen", False):
        return sys.executable, f"run-schedule {sched_id}"
    exe = sys.executable
    pyw = exe.replace("python.exe", "pythonw.exe")
    if Path(pyw).exists():
        exe = pyw  # GUI Python -> no console window
    return exe, f"-m investraton run-schedule {sched_id}"


def _task_xml(sched: dict) -> str:
    """Full Task Scheduler XML. StartWhenAvailable=true makes Windows run a task that
    was MISSED (PC off/asleep) as soon as it's available — i.e. on next power-on."""
    exe, args = _run_command(sched["id"])
    return (
        '<?xml version="1.0" encoding="UTF-16"?>\n'
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
        f'  <RegistrationInfo><Description>Investraton: {_xml_escape(sched.get("name", ""))}</Description></RegistrationInfo>\n'
        f'  <Triggers>{_trigger_xml(sched)}</Triggers>\n'
        '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType>'
        '<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n'
        '  <Settings>\n'
        '    <StartWhenAvailable>true</StartWhenAvailable>\n'
        '    <Enabled>true</Enabled>\n'
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n'
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n'
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n'
        '    <AllowStartOnDemand>true</AllowStartOnDemand>\n'
        '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>\n'
        '  </Settings>\n'
        f'  <Actions Context="Author"><Exec><Command>{_xml_escape(exe)}</Command>'
        f'<Arguments>{_xml_escape(args)}</Arguments></Exec></Actions>\n'
        '</Task>\n'
    )


def sync_windows_tasks() -> dict:
    """Create/update Task Scheduler entries for enabled schedules; remove others.

    Tasks are created from XML so they include StartWhenAvailable (run missed runs on
    next power-on). Best-effort: failures are reported, not raised.
    """
    if not sys.platform.startswith("win"):
        return {"ok": False, "error": "Task Scheduler is Windows-only.", "results": []}

    results = []
    existing = _list_existing_tasks()
    wanted_ids = set()
    for sched in load_schedules():
        task_name = f"{TASK_PREFIX}\\{sched['id']}"
        if not sched.get("enabled", True):
            continue
        wanted_ids.add(task_name)
        try:
            xml_path = Path(tempfile.gettempdir()) / f"investraton_{sched['id']}.xml"
            xml_path.write_text(_task_xml(sched), encoding="utf-16")
            p = subprocess.run(
                ["schtasks", "/Create", "/TN", task_name, "/XML", str(xml_path), "/F"],
                capture_output=True, text=True, timeout=30, creationflags=_NO_WINDOW,
            )
            xml_path.unlink(missing_ok=True)
            ok = p.returncode == 0
            results.append({"name": sched["name"], "id": sched["id"], "ok": ok,
                            "detail": (p.stdout or p.stderr).strip()[:200]})
        except Exception as e:  # noqa: BLE001
            results.append({"name": sched["name"], "id": sched["id"], "ok": False, "detail": str(e)})

    # Remove tasks we created before but that are no longer wanted (deleted/disabled).
    for name in existing:
        if name.startswith(f"{TASK_PREFIX}\\") and name not in wanted_ids:
            try:
                subprocess.run(["schtasks", "/Delete", "/F", "/TN", name],
                               capture_output=True, text=True, timeout=30, creationflags=_NO_WINDOW)
            except Exception:  # noqa: BLE001
                pass

    return {"ok": all(r["ok"] for r in results) if results else True, "results": results}


def _list_existing_tasks() -> list[str]:
    try:
        p = subprocess.run(["schtasks", "/Query", "/FO", "LIST"],
                           capture_output=True, text=True, timeout=30, creationflags=_NO_WINDOW)
        names = []
        for line in p.stdout.splitlines():
            if line.startswith("TaskName:"):
                names.append(line.split(":", 1)[1].strip().lstrip("\\"))
        return names
    except Exception:  # noqa: BLE001
        return []
