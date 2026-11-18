"""Removal for good and stricter hiding reach every store under /data.

Cognee deletes a document's data by marking it deleted: LanceDB keeps the old data files and versions of every table
until they are compacted and cleaned up, the graph database (Ladybug) keeps deleted nodes' strings in its file, and
SQLite keeps deleted rows in free pages. Snapshots and backups copy those files whole. So after a removal for good or a
re-read with stricter hiding, and before anything is saved, `purge()` rewrites each store without what was deleted,
and `left()` searches every file under /data, byte by byte, for the removed or hidden text: what it finds fails the
job, so nothing is committed or backed up.

What is searched for (`removed_probes`, `hidden_probes`): a hidden value itself; for a removed document, pieces of
its text (runs of words between line breaks and sentence ends, at least PROBE_MIN characters, as a chunk, a summary
or a graph node holds them), ignoring ASCII case, since entity names may be stored in lower case. A probe found that
a kept document's text also holds doesn't count: it may rightly stay, in that document's data.

This module never imports Cognee; the databases are opened with their own libraries, after the process that used
Cognee has exited, so nothing else holds them open.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from collections.abc import Callable, Iterable
from datetime import timedelta
from pathlib import Path

PROBE_MIN = 24  # shortest piece of a removed document searched for
PROBES_PER_DOCUMENT = 64
PROBES_MAX = 512
BLOCK = 8 << 20
DELETED_SHARE = 1e-9  # a fragment with any deleted row is rewritten

# Where a removed text is cut into pieces: line breaks, sentence ends, runs of spaces (a chunker may squeeze them),
# and characters a JSON string escapes.
CUTS = re.compile(r"\s{2,}|[\t\r\n\f\v]|(?<=[.!?])\s|[\"\\\x00-\x1f]")


def _key(value: str) -> bytes:
    """A value as searched for: its UTF-8 bytes with ASCII letters in lower case (as bytes.lower() treats a file)."""
    return value.encode("utf-8").lower()


def _spread(items: list[str], count: int) -> list[str]:
    if len(items) <= count:
        return items
    step = len(items) / count
    return [items[int(i * step)] for i in range(count)]


def removed_probes(removed: list[str]) -> list[str]:
    """Pieces of the removed documents' texts, at most PROBES_PER_DOCUMENT each, spread over the whole text."""
    out: list[str] = []
    seen: set[bytes] = set()
    for text in removed:
        pieces = []
        for piece in CUTS.split(text):
            piece = piece.strip()
            if len(piece) >= PROBE_MIN and _key(piece) not in seen:
                seen.add(_key(piece))
                pieces.append(piece)
        out.extend(_spread(pieces, PROBES_PER_DOCUMENT))
    return _spread(out, PROBES_MAX)


def hidden_probes(texts: list[str], rules: dict) -> list[str]:
    """The values `rules` hide in `texts` (the stored texts before a stricter re-read)."""
    import hide

    out: dict[bytes, str] = {}
    for text in texts:
        for span in hide.find_spans(text, rules):
            value = text[span.start : span.end].strip()
            if value:
                out.setdefault(_key(value), value)
    return _spread(list(out.values()), PROBES_MAX)


def found(root: Path, probes: list[str]) -> dict[bytes, dict[str, int]]:
    """For each probe found under `root` (ignoring ASCII case): the files holding it, and how many times. Files are
    read in blocks, so a large one never sits in memory whole; a probe across two blocks is found too."""
    needles = sorted({_key(p) for p in probes if p})
    if not needles or not root.exists():
        return {}
    overlap = max(len(n) for n in needles) - 1
    out: dict[bytes, dict[str, int]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        name = str(path.relative_to(root))
        tail = b""
        for block in _blocks(path, name):
            window = tail + block.lower()
            for needle in needles:
                at = window.find(needle)
                while at >= 0:
                    if at + len(needle) > len(tail):  # not wholly in the overlap, counted with the last block
                        files = out.setdefault(needle, {})
                        files[name] = files.get(name, 0) + 1
                    at = window.find(needle, at + 1)
            tail = window[-overlap:] if overlap else b""
    return out


def _blocks(path: Path, name: str):
    """A file's bytes, block by block. A stored text (text/<id>.json) without its document's name: hiding applies to
    a document's text, and its name is shown wherever the document is."""
    if name.startswith("text/") and name.endswith(".json"):
        try:
            stored = json.loads(path.read_text())
        except (OSError, ValueError):
            stored = None
        if isinstance(stored, dict):
            stored.pop("name", None)
            yield json.dumps(stored, ensure_ascii=False).encode("utf-8")
            return
    with path.open("rb") as handle:
        while block := handle.read(BLOCK):
            yield block


def left(root: Path, probes: list[str], kept: Callable[[], Iterable[str]]) -> dict[str, int]:
    """The files under `root` still holding removed or hidden text, with how many times: every probe found, except
    one a kept document's text holds too (it may rightly stay, in that document's data). The kept texts are read
    only for a probe found, one at a time."""
    out: dict[str, int] = {}
    for needle, files in found(root, probes).items():
        if any(needle in _key(text) for text in kept()):
            continue
        for name, count in files.items():
            out[name] = out.get(name, 0) + count
    return out


# --------------------------------------------------------------------------- the stores


def compact_vectors(lancedb_dir: Path) -> list[str]:
    """Every LanceDB table rewritten without its deleted rows, however few (LanceDB's own optimize, and Cognee's
    compaction, leave a fragment alone until a tenth or a fifth of its rows are deleted), then every older version and
    every file only an older version used removed. Nothing else has the tables open: Cognee's process has exited."""
    if not lancedb_dir.exists():
        return []
    import lance

    names = []
    for table in sorted(lancedb_dir.glob("*.lance")):
        lance.dataset(str(table)).optimize.compact_files(
            materialize_deletions=True, materialize_deletions_threshold=DELETED_SHARE, compaction_mode="reencode"
        )
        lance.dataset(str(table)).cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        names.append(table.stem)
    return names


GRAPH_COUNTS = ("MATCH (n) RETURN COUNT(n)", "MATCH ()-[r]->() RETURN COUNT(r)")


def _graph(path: Path, statement: str) -> tuple[int, ...]:
    """Runs one statement on the graph database at `path`, checkpoints and closes it; returns its node and edge
    counts (taken after the statement)."""
    import ladybug

    database = ladybug.Database(str(path))
    connection = ladybug.Connection(database)
    try:
        connection.execute(statement)
        connection.execute("CHECKPOINT")
        return tuple(int(connection.execute(q).get_next()[0]) for q in GRAPH_COUNTS)
    finally:
        connection.close()
        database.close()


def rebuild_graph(graph_file: Path, work: Path) -> bool:
    """The graph database written anew from what it holds now (exported, then imported into a new file), so deleted
    nodes' strings don't stay in its pages. The new file replaces the old one only when it holds as many nodes and
    edges."""
    if not graph_file.exists():
        return False
    export = work / "graph-export"
    rebuilt = graph_file.with_name(graph_file.name + ".rebuilt")
    leftovers = (rebuilt, Path(f"{rebuilt}.wal"))
    shutil.rmtree(export, ignore_errors=True)
    for path in leftovers:
        path.unlink(missing_ok=True)
    try:
        before = _graph(graph_file, f"EXPORT DATABASE '{export}'")
        after = _graph(rebuilt, f"IMPORT DATABASE '{export}'")
        if after != before:
            raise RuntimeError(f"the rebuilt graph holds {after} nodes and edges, not {before}")
        os.replace(rebuilt, graph_file)
        Path(f"{graph_file}.wal").unlink(missing_ok=True)
    finally:
        shutil.rmtree(export, ignore_errors=True)  # it held every live text: never left behind
        for path in leftovers:
            path.unlink(missing_ok=True)
    return True


def vacuum_relational(db_file: Path | None) -> bool:
    """SQLite rewritten without its free pages (deleted rows stay in them otherwise)."""
    if db_file is None or not db_file.exists():
        return False
    conn = sqlite3.connect(db_file)
    try:
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # in WAL mode the old pages would wait in the -wal file
    finally:
        conn.close()
    return True


def clear_logs(logs_dir: Path | None) -> int:
    """Cognee's log files deleted (outside /data, so in a snapshot but not a backup). They held no document text in any
    run, but an error message could quote one, and nothing reads them: the container's files can't be reached."""
    if logs_dir is None or not logs_dir.is_dir():
        return 0
    removed = 0
    for path in logs_dir.rglob("*"):
        if path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def purge(databases_dir: Path, relational_db: Path | None, work: Path, logs_dir: Path | None = None) -> dict:
    """Every store rewritten without what was deleted. Returns what was done, for the job's result."""
    return {
        "vectorTables": len(compact_vectors(databases_dir / "cognee.lancedb")),
        "graphRebuilt": rebuild_graph(databases_dir / "cognee_graph_ladybug", work),
        "relationalVacuumed": vacuum_relational(relational_db),
        "logsCleared": clear_logs(logs_dir),
    }
