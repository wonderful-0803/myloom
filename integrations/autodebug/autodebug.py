#!/usr/bin/env python3
"""Loom's bridge to BugFixer (AI-Native: AutoDebug): read a repair round's progress and start or stop a round.

Only reads BugFixer's own progress files; starting and stopping go through BugFixer's CLI, which keeps its own locks,
Feishu write-back and Gitee draft-PR rules. Nothing here talks to Feishu or Gitee or reads credentials.

  status                       one JSON object: running process, stop switch, current round and its per-bug results
  start [--resume]             start one `bugfixer.cli run` in the background; refuses while a round runs or is stopped
                               (--resume clears the stop switch first; use it only when the owner explicitly asks)
  stop                         set BugFixer's stop switch (`bugfixer.cli switch stop`)
  watch --state FILE           block until something new happens in the current round, print each event as one JSON line,
                               and remember it in FILE so the same event is never reported twice
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

TERMINAL = {"awaiting_human_review", "manual_required", "cancelled"}


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def running_pids():
    """PIDs of `bugfixer.cli run` processes, found through /proc so nothing is locked or signalled."""
    pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        words = [a.decode("utf-8", "replace") for a in args if a]
        if "bugfixer.cli" in words and "run" in words and int(entry.name) != os.getpid():
            pids.append(int(entry.name))
    return pids


class BugFixer:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.local = self.root / ".local"
        if not (self.root / "bugfixer").is_dir():
            raise SystemExit(f"Not a BugFixer checkout: {self.root}")

    def stopped(self):
        db = self.local / "state.db"
        if not db.exists():
            return False
        try:
            with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5) as conn:
                row = conn.execute("SELECT stopped FROM switches WHERE id=1").fetchone()
            return bool(row and row[0])
        except sqlite3.Error:
            return False

    def workflow_dir(self):
        dirs = sorted((self.local / "pilot-runs").glob("automatic-*"), key=lambda p: p.stat().st_mtime, reverse=True)
        return dirs[0] if dirs else None

    def current_batch(self):
        """The round in progress (active.json), else the newest finished one."""
        directory = self.workflow_dir()
        if not directory:
            return None, False
        active = read_json(directory / "active.json")
        if active and str(active.get("batch", "")).startswith("batch-"):
            return directory / active["batch"], True
        batches = sorted(directory.glob("batch-*"), key=lambda p: p.stat().st_mtime, reverse=True)
        return (batches[0] if batches else None), False

    def snapshot(self):
        batch, active = self.current_batch()
        pids = running_pids()
        info = {"running": bool(pids), "pids": pids, "stopped": self.stopped(), "batch": None}
        if not batch:
            return info
        snap = read_json(batch / "snapshot.json", {}) or {}
        order = [str((r.get("fields") or {}).get("Bug编号") or r.get("record_id")) for r in snap.get("records", [])]
        results = read_json(batch / "report.json", []) or []
        final = read_json(batch / "final-report.json")
        info["batch"] = {
            "id": batch.name, "active": active, "started": datetime.fromtimestamp((batch / "snapshot.json").stat().st_mtime).isoformat(timespec="seconds")
            if (batch / "snapshot.json").exists() else None,
            "total": len(order), "order": order,
            "results": [{k: r.get(k) for k in ("ticket_id", "state", "pr_url", "error")} for r in results],
            "finished": bool(final) and not active,
            "summary": {k: final.get(k) for k in ("completed", "manual", "pending")} if final else None,
        }
        return info

    def start(self, resume=False):
        if running_pids():
            return {"started": False, "reason": "A BugFixer round is already running; follow it instead of starting another."}
        if self.stopped():
            if not resume:
                return {"started": False, "reason": "BugFixer's stop switch is on; starting again needs the owner's explicit request to resume."}
            subprocess.run([str(self.root / ".venv/bin/python"), "-m", "bugfixer.cli", "switch", "resume"], cwd=self.root, check=True,
                           capture_output=True, text=True, timeout=60)
        run_dir = self.local / "service-runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
        run_dir.mkdir(parents=True, exist_ok=True)
        log = run_dir / "workflow.log"
        command = [".venv/bin/python", "-u", "-m", "bugfixer.cli", "run"]
        with log.open("ab") as out:
            # A new session keeps the round alive when the Loom worker that started it is paused or replaced.
            process = subprocess.Popen(command, cwd=self.root, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                       start_new_session=True)
        meta = {"directory": str(run_dir), "pid": process.pid, "started_at": datetime.now().astimezone().isoformat(),
                "command": command, "log": str(log), "started_by": "loom"}
        (run_dir / "process.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        (self.local / "service-runs" / "latest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(3)
        alive = process.poll() is None
        return {"started": True, "pid": process.pid, "alive_after_3s": alive, "log": str(log),
                **({} if alive else {"exit_code": process.returncode, "log_tail": log.read_text(encoding="utf-8", errors="replace")[-800:]})}

    def stop(self):
        done = subprocess.run([str(self.root / ".venv/bin/python"), "-m", "bugfixer.cli", "switch", "stop"], cwd=self.root,
                              capture_output=True, text=True, timeout=60)
        return {"stopped": done.returncode == 0, "output": (done.stdout + done.stderr)[-400:],
                "note": "Running containers stop at their next heartbeat; queued bugs are not started."}

    def events(self, seen):
        """New events compared with `seen`; mutates `seen` to include them."""
        info = self.snapshot()
        batch = info["batch"]
        out = []
        if batch and batch["id"] != seen.get("batch"):
            seen.update(batch=batch["id"], items=[], finished=False)
            if batch["active"] or info["running"]:
                out.append({"event": "round_started", "batch": batch["id"], "total": batch["total"], "order": batch["order"]})
        if batch:
            for item in batch["results"]:
                key = f"{item['ticket_id']}:{item['state']}"
                if item["state"] in TERMINAL and key not in seen["items"]:
                    seen["items"].append(key)
                    out.append({"event": "bug_outcome", **item})
            if batch["finished"] and not seen.get("finished"):
                seen["finished"] = True
                out.append({"event": "round_finished", "batch": batch["id"], **(batch["summary"] or {}), "total": batch["total"]})
        if info["stopped"] and not seen.get("stopped"):
            out.append({"event": "stopped"})
        seen["stopped"] = info["stopped"]
        return out, info


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bugfixer", default=os.environ.get("BUGFIXER_DIR", "~/projects/BugFixer"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    start = sub.add_parser("start")
    start.add_argument("--resume", action="store_true")
    sub.add_parser("stop")
    watch = sub.add_parser("watch")
    watch.add_argument("--state", required=True, help="File in the task directory remembering reported events")
    watch.add_argument("--timeout", type=int, default=1800)
    watch.add_argument("--interval", type=int, default=15)
    args = parser.parse_args()
    bf = BugFixer(args.bugfixer)

    if args.command == "status":
        print(json.dumps(bf.snapshot(), ensure_ascii=False, indent=2))
    elif args.command == "start":
        print(json.dumps(bf.start(args.resume), ensure_ascii=False, indent=2))
    elif args.command == "stop":
        print(json.dumps(bf.stop(), ensure_ascii=False, indent=2))
    else:
        state = Path(args.state)
        seen = read_json(state, {}) or {}
        first = not state.exists()
        deadline = time.monotonic() + args.timeout
        while True:
            events, info = bf.events(seen)
            in_progress = info["running"] or (info["batch"] or {}).get("active")
            if first and not in_progress:
                # A task's first watch records an earlier, finished round as seen instead of replaying it.
                events = []
            first = False
            state.write_text(json.dumps(seen, ensure_ascii=False), encoding="utf-8")
            if events:
                for event in events:
                    print(json.dumps(event, ensure_ascii=False))
                return
            if not in_progress:
                print(json.dumps({"event": "idle", "running": False, "batch": (info["batch"] or {}).get("id")}, ensure_ascii=False))
                return
            if time.monotonic() >= deadline:
                print(json.dumps({"event": "no_change", "running": info["running"]}, ensure_ascii=False))
                return
            time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
