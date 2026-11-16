"""Container main process: a small control server on :8080, grown from the PoC's.

It never imports Cognee and never touches /data at startup, so a container restored from a snapshot comes up with
exactly the files the snapshot holds. Each Cognee operation runs as a separate process (ops.py) in its own process
group, and a job is finished only when that whole group has exited. The query process (query.py) is the one Cognee
process that stays loaded between questions; operations that open the databases refuse to start while it runs.

Endpoints
  GET  /health                  liveness, boot id, the database format of this image, the query process's state
  PUT  /inbox/<batch>/<name>    stage a file of an import (outside /data, deleted as soon as it is read)
  DELETE /inbox/<batch>
  POST /jobs                    {"op": ..., "args": {...}} -> start a job
  GET  /jobs/<id>               job status, progress and result
  GET  /quiesce                 proves no job, no query process, no stray process, no open file under /data,
                                nothing staged: the only state in which the Durable Object takes a snapshot
  POST /cleanup                 delete finished jobs' files and anything staged, before a snapshot
  POST /query/start|open|stop   the query process: load models (no /data), then open the databases, or stop it
  GET  /query/status            its state, and how many files under /data it holds open
  POST /query/search            a question, answered by the query process
  GET  /text/<documentId>       a learned document's redacted text and page map (the Durable Object copies it to R2)
  GET  /files/<path>            a file under /data, for backups
  PUT  /files/<path>            put a file under /data, when coming back from a backup (only when nothing runs)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8080
QUERY_PORT = 8081
DATA_DIR = Path("/data")
INBOX = Path(os.environ.get("KNOWLEDGE_INBOX", "/var/lib/knowledge/inbox"))
RUN_DIR = Path(os.environ.get("KNOWLEDGE_RUN", "/var/lib/knowledge/run"))
WORK_DIR = Path(os.environ.get("KNOWLEDGE_WORK", "/var/lib/knowledge/work"))
HERE = Path(__file__).parent
OPS = HERE / "ops.py"
QUERY = HERE / "query.py"
DATA_FORMAT = os.environ.get("KNOWLEDGE_DATA_FORMAT", "unknown")
TEST_CONTROLS = os.environ.get("KNOWLEDGE_TEST_CONTROLS") == "1"
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
GROUP_EXIT_TIMEOUT_S = 60
OPENS_DATABASES = {"ingest", "remove", "reread", "stats"}

BOOT_ID = uuid.uuid4().hex[:12]
BOOTED_AT = datetime.now(timezone.utc).isoformat()
BOOTED_MONO = time.monotonic()

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_active: str | None = None  # Cognee ops are exclusive: one writer/reader of /data at a time
_query: dict = {"proc": None}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _processes() -> list[dict]:
    out = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        fields = stat[stat.rfind(")") + 2 :].split()
        out.append({"pid": int(entry.name), "state": fields[0], "ppid": int(fields[1]), "pgid": int(fields[2]), "cmd": cmdline[:200]})
    return sorted(out, key=lambda p: p["pid"])


def _open_data_files(pgid: int | None = None) -> list[dict]:
    """Every file descriptor (of one process group, or of any process) that points under /data."""
    groups = {p["pid"]: p["pgid"] for p in _processes()} if pgid is not None else None
    found = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        if groups is not None and groups.get(int(proc.name)) != pgid:
            continue
        try:
            fds = list((proc / "fd").iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith(str(DATA_DIR) + "/") or target == str(DATA_DIR):
                found.append({"pid": int(proc.name), "fd": int(fd.name), "path": target})
    return found


def _inbox_files() -> int:
    return sum(1 for p in INBOX.rglob("*") if p.is_file()) if INBOX.exists() else 0


def _safe_data_path(parts: list[str]) -> Path | None:
    if not parts or any(p in ("", ".", "..") or "\0" in p for p in parts):
        return None
    path = DATA_DIR.joinpath(*parts)
    try:
        path.resolve().relative_to(DATA_DIR.resolve())
    except ValueError:
        return None
    return path


# --------------------------------------------------------------------------- jobs


def _run_job(job: dict, argv: list[str]) -> None:
    global _active
    log = (RUN_DIR / f"{job['id']}.log").open("wb")
    try:
        proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        job["pid"] = proc.pid
        exit_code = proc.wait()
        deadline = time.monotonic() + GROUP_EXIT_TIMEOUT_S
        while _group_alive(proc.pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        lingering = [p for p in _processes() if p["pgid"] == proc.pid and p["state"] != "Z"]
        job["lingering"] = lingering
        result_path = Path(job["resultPath"])
        if result_path.exists():
            job["result"] = json.loads(result_path.read_text())
        job["exitCode"] = exit_code
        job["state"] = "succeeded" if exit_code == 0 and not lingering else "failed"
    except Exception as error:  # noqa: BLE001 - reported to the caller
        job["state"] = "failed"
        job["error"] = type(error).__name__
    finally:
        log.close()
        job["endedAt"] = _now()
        job["durationMs"] = round((time.monotonic() - job["_mono"]) * 1000)
        with _lock:
            _active = None


def _start_job(op: str, args: dict) -> tuple[int, dict]:
    global _active
    with _lock:
        if _active is not None:
            return 409, {"error": "busy", "activeJob": _public(_jobs[_active])}
        if op in OPENS_DATABASES and _query_running():
            return 409, {"error": "query_running"}
        job_id = f"{op}-{uuid.uuid4().hex[:8]}"
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        job = {
            "id": job_id,
            "op": op,
            "state": "running",
            "startedAt": _now(),
            "_mono": time.monotonic(),
            "resultPath": str(RUN_DIR / f"{job_id}.result.json"),
            "progressPath": str(RUN_DIR / f"{job_id}.progress.json"),
        }
        argv = [sys.executable, str(OPS), op, "--result", job["resultPath"], "--progress", job["progressPath"]]
        if op in ("ingest", "remove", "reread"):
            batch = str(args.get("batchId", ""))
            if not SAFE_NAME.match(batch) or not (INBOX / batch / "batch.json").exists():
                return 400, {"error": "invalid or unstaged batchId"}
            argv += ["--batch-dir", str(INBOX / batch)]
        elif op == "grep":
            if not TEST_CONTROLS:
                return 404, {"error": "unknown op"}
            values = RUN_DIR / f"{job_id}.values.json"
            values.write_text(json.dumps([str(v) for v in args.get("values") or []]))
            argv += ["--values", str(values)]
        elif op not in ("stats", "manifest"):
            return 400, {"error": f"unknown op {op}"}
        _jobs[job_id] = job
        _active = job_id
    threading.Thread(target=_run_job, args=(job, argv), daemon=True).start()
    return 202, _public(job)


def _public(job: dict) -> dict:
    view = {k: v for k, v in job.items() if not k.startswith("_") and not k.endswith("Path")}
    # A crashed op leaves no result; its last progress names the file it was on.
    if job["state"] in ("running", "failed"):
        try:
            view["progress"] = json.loads(Path(job["progressPath"]).read_text())
        except (OSError, ValueError):
            pass
    return view


def _cleanup() -> dict:
    """Deletes finished jobs' files and everything staged, so a snapshot holds neither."""
    removed = 0
    with _lock:
        running = {_active} if _active else set()
    for path in RUN_DIR.glob("*") if RUN_DIR.exists() else []:
        if not any(path.name.startswith(job_id) for job_id in running):
            path.unlink(missing_ok=True)
            removed += 1
    for root in (INBOX, WORK_DIR):
        if root.exists():
            for child in root.iterdir():
                shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
    return {"removed": removed}


# --------------------------------------------------------------------------- the query process


def _query_running() -> bool:
    proc = _query["proc"]
    return proc is not None and proc.poll() is None


def _query_call(method: str, path: str, body: dict | None = None, timeout: float = 30) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"http://127.0.0.1:{QUERY_PORT}{path}", data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def _query_status() -> dict:
    if not _query_running():
        return {"state": "stopped", "dataFilesOpen": 0, "loadedAt": None, "openedAt": None, "error": None}
    pgid = _query["proc"].pid
    try:
        _, status = _query_call("GET", "/status", timeout=2)
    except (urllib.error.URLError, OSError, ValueError):
        status = {"state": "loading", "loadedAt": None, "openedAt": None, "error": None}
    status["dataFilesOpen"] = len(_open_data_files(pgid))
    return status


def _query_start() -> dict:
    if not _query_running():
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        log = (RUN_DIR / "query.log").open("ab")
        _query["proc"] = subprocess.Popen([sys.executable, str(QUERY)], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return _query_status()


def _group_members(pgid: int) -> list[dict]:
    """Live processes of a group (a zombie holds no file open; tini reaps it)."""
    return [p for p in _processes() if p["pgid"] == pgid and p["state"] != "Z"]


def _signal_group(pgid: int, signo: int) -> None:
    try:
        os.killpg(pgid, signo)
    except ProcessLookupError:
        pass


def _query_stop() -> dict:
    """Stops the query process and everything it started, so nothing holds a database open."""
    proc = _query["proc"]
    if proc is not None:
        pgid = proc.pid
        _signal_group(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _signal_group(pgid, signal.SIGKILL)
            proc.wait()
        deadline = time.monotonic() + 30
        while _group_members(pgid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if _group_members(pgid):
            _signal_group(pgid, signal.SIGKILL)
            time.sleep(0.5)
    _query["proc"] = None
    return _query_status()


# --------------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "knowledge-engine/1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{_now()}] {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def _send(self, status: int, body: dict) -> None:
        payload = json.dumps(body, default=str, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, path: Path) -> None:
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(size))
        self.end_headers()
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile, 1 << 20)

    def _body(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def _body_to(self, path: Path) -> None:
        length = int(self.headers.get("content-length") or 0)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            while length > 0:
                chunk = self.rfile.read(min(length, 1 << 20))
                if not chunk:
                    break
                handle.write(chunk)
                length -= len(chunk)

    def _parts(self) -> list[str]:
        from urllib.parse import unquote

        return [unquote(p) for p in self.path.split("?")[0].split("/") if p]

    def do_GET(self):
        parts = self._parts()
        if parts == ["health"]:
            with _lock:
                active = _active
            return self._send(
                200,
                {
                    "ok": True,
                    "bootId": BOOT_ID,
                    "bootedAt": BOOTED_AT,
                    "uptimeMs": round((time.monotonic() - BOOTED_MONO) * 1000),
                    "activeJob": active,
                    "dataFormat": DATA_FORMAT,
                    "query": {"state": "running" if _query_running() else "stopped"},
                },
            )
        if len(parts) == 2 and parts[0] == "jobs":
            job = _jobs.get(parts[1])
            return self._send(200, _public(job)) if job else self._send(404, {"error": "no such job"})
        if parts == ["quiesce"]:
            with _lock:
                active = _active
            job_groups = {job.get("pid") for job in _jobs.values() if job.get("pid")}
            stray = [p for p in _processes() if p["pgid"] in job_groups and p["state"] != "Z"]
            open_files = _open_data_files()
            inbox = _inbox_files()
            os.sync()
            query = "running" if _query_running() else "stopped"
            return self._send(
                200,
                {
                    "quiescent": active is None and query == "stopped" and not stray and not open_files and inbox == 0,
                    "activeJob": active,
                    "query": query,
                    "strayProcesses": stray,
                    "openDataFiles": open_files,
                    "inboxFiles": inbox,
                },
            )
        if parts == ["query", "status"]:
            return self._send(200, _query_status())
        if len(parts) == 2 and parts[0] == "text" and SAFE_NAME.match(parts[1]):
            path = DATA_DIR / "text" / f"{parts[1]}.json"
            return self._send_file(path) if path.is_file() else self._send(404, {"error": "no such text"})
        if len(parts) >= 2 and parts[0] == "files":
            path = _safe_data_path(parts[1:])
            return self._send_file(path) if path and path.is_file() else self._send(404, {"error": "no such file"})
        return self._send(404, {"error": "not found"})

    def do_PUT(self):
        parts = self._parts()
        if len(parts) == 3 and parts[0] == "inbox" and all(SAFE_NAME.match(p) for p in parts[1:]):
            self._body_to(INBOX / parts[1] / parts[2])
            return self._send(201, {"stored": f"{parts[1]}/{parts[2]}"})
        if len(parts) >= 2 and parts[0] == "files":
            path = _safe_data_path(parts[1:])
            with _lock:
                busy = _active is not None or _query_running()
            if path is None:
                return self._send(400, {"error": "bad path"})
            if busy:
                return self._send(409, {"error": "busy"})
            self._body_to(path)
            return self._send(201, {"stored": "/".join(parts[1:])})
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        parts = self._parts()
        if len(parts) == 2 and parts[0] == "inbox" and SAFE_NAME.match(parts[1]):
            shutil.rmtree(INBOX / parts[1], ignore_errors=True)
            return self._send(200, {"deleted": parts[1]})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        parts = self._parts()
        if parts == ["jobs"]:
            try:
                body = json.loads(self._body() or b"{}")
            except ValueError:
                return self._send(400, {"error": "invalid JSON"})
            status, payload = _start_job(str(body.get("op", "")), body.get("args") or {})
            return self._send(status, payload)
        if parts == ["cleanup"]:
            return self._send(200, _cleanup())
        if parts == ["query", "start"]:
            with _lock:
                if _active is not None and _jobs[_active]["op"] in OPENS_DATABASES:
                    return self._send(409, {"error": "busy"})
                return self._send(200, _query_start())
        if parts == ["query", "stop"]:
            return self._send(200, _query_stop())
        if parts in (["query", "open"], ["query", "search"]):
            if not _query_running():
                return self._send(409, {"error": "query process not running"})
            body = self._body()
            try:
                status, payload = _query_call("POST", f"/{parts[1]}", json.loads(body or b"{}"), timeout=120)
            except (urllib.error.URLError, OSError, ValueError) as error:
                return self._send(503, {"error": type(error).__name__})
            return self._send(status, payload)
        return self._send(404, {"error": "not found"})


def main() -> None:
    for path in (INBOX, RUN_DIR, WORK_DIR):
        path.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(f"knowledge engine control server boot={BOOT_ID} format={DATA_FORMAT} listening on :{PORT}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
