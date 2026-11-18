"""Removal for good and stricter hiding reach every store under /data.

Cognee deletes a document's data by marking it deleted: LanceDB keeps the old data files and versions of every table
until they are compacted and cleaned up, the graph database (Ladybug) keeps deleted nodes' strings in its file, and
SQLite keeps deleted rows in free pages. Snapshots and backups copy those files whole. So after a removal for good or a
re-read with stricter hiding, and before anything is saved, `purge()` rewrites each store without what was deleted and
checks that no store keeps an older version, a deleted row or a free page. Then `left()` reads what the stores hold
now, decoded, and looks for the removed or hidden text: what it finds fails the job, so nothing is committed or backed
up.

What is looked for (`removed_probes`, `hidden_probes`): every value the stricter rules hid; for a removed document,
every piece of its text (runs of words between line breaks and sentence ends, at least PROBE_MIN characters, as a
chunk, a summary or a graph node holds them). A probe matches as the hiding detector matches a word: ignoring case
exactly as `re.IGNORECASE` does (`fold()`: "Pin" is "pın", "İ" is "i", "ſ" is "s") and whole, with no letter or digit
just before or after it. One that a kept document's text holds too doesn't count: it may rightly stay, in that
document's data. Each probe is looked for only where the rarest of its words stands (`Matcher`), so the cost follows
the data, however many probes share a word.

Where it is looked for (`content()`): only values made from the documents, never keys, schemas or the stores' own
bookkeeping (ids, types, paths, states): the stored texts, Cognee's copies of them, its chunks, entity names, summaries
and relations in LanceDB and the graph, and the facts. Summaries, relations and facts also hold Cognee's own words
(its entity labels and relation names, as stored, `headquartered_in`, and as written, "is part of"): a probe found
there that is one of those, or some of its words in a row, doesn't count.
Any file under /data this module doesn't know is read whole, as text.

This module never imports Cognee; the databases are opened with their own libraries, after the process that used
Cognee has exited, so nothing else holds them open.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from collections.abc import Callable, Iterable, Iterator
from datetime import timedelta
from pathlib import Path

PROBE_MIN = 24  # shortest piece of a removed document looked for
DELETED_SHARE = 1e-9  # a fragment with any deleted row is rewritten

# Where a removed text is cut into pieces: line breaks, sentence ends and runs of spaces (a chunker may squeeze them).
CUTS = re.compile(r"\s{2,}|[\t\r\n\f\v\x00-\x1f]|(?<=[.!?])\s")
WORD = re.compile(r"\w+")

LANCEDB = Path("system/databases/cognee.lancedb")
GRAPH = Path("system/databases/cognee_graph_ladybug")
RELATIONAL = Path("system/databases/cognee_db")
# LanceDB tables by what their `text` holds: document text, Cognee's own words (entity labels), document ids. Any
# other table (summaries, relations) holds both document text and Cognee's words.
DOCUMENT_TABLES = {"DocumentChunk_text", "Entity_name"}
COGNEE_TABLES = {"EntityType_name"}
ID_TABLES = {"TextDocument_name"}


def removed_probes(removed: list[str]) -> list[str]:
    """Every piece of the removed documents' texts (once, whatever its case: it is matched ignoring case)."""
    out: dict[str, str] = {}
    for text in removed:
        for piece in CUTS.split(text):
            piece = piece.strip()
            if len(piece) >= PROBE_MIN:
                out.setdefault(fold(piece), piece)
    return list(out.values())


def hidden_probes(texts: list[str], rules: dict) -> list[str]:
    """Every value `rules` hide in `texts` (the stored texts before a stricter re-read), once whatever its case."""
    import hide

    out: dict[str, str] = {}
    for text in texts:
        for span in hide.find_spans(text, rules):
            value = text[span.start : span.end].strip()
            if value:
                out.setdefault(fold(value), value)
    return list(out.values())


_FOLD: dict[int, int] | None = None


def _fold_table() -> dict[int, int]:
    """Every character `re.IGNORECASE` matches to another, mapped to one of its class: the regular expression engine's
    own rule (its simple lower case, then its extra equivalences, re/_casefix.py), so two strings fold alike exactly
    when one matches the other ignoring case, character for character."""
    global _FOLD
    if _FOLD is None:
        import _sre
        from re._casefix import _EXTRA_CASES

        smallest = {lower: min((lower, *others)) for lower, others in _EXTRA_CASES.items()}
        table = {}
        for code in range(0x110000):
            if _sre.unicode_iscased(code):
                folded = _sre.unicode_tolower(code)
                folded = smallest.get(folded, folded)
                if folded != code:
                    table[code] = folded
        _FOLD = table
    return _FOLD


def fold(text: str) -> str:
    """`text` with every character replaced by its class under `re.IGNORECASE` (one character for one)."""
    return text.translate(_fold_table())


class Matcher:
    """Finds many probes in a text at once, each as the hiding detector finds a word (hide.py `_words`): ignoring case
    and whole. Each probe is filed under its rarest word among the probes (and that word's place in it); the text is
    folded once, and only where one of those words stands is the folded text there compared with the probes filed
    under it, of each length, then each match confirmed with the probe's own expression. The cost follows the text,
    however many probes share a word."""

    def __init__(self, probes: Iterable[str]) -> None:
        probes = list(dict.fromkeys(p for p in probes if p))
        words = {p: [(m.group(), m.start()) for m in WORD.finditer(fold(p))] for p in probes}
        shared: dict[str, int] = {}
        for probe in probes:
            for word in {w for w, _ in words[probe]}:
                shared[word] = shared.get(word, 0) + 1
        # word -> its place in the probe -> the probe's length -> the folded probe -> [(probe, expression)]
        self.filed: dict[str, dict[int, dict[int, dict[str, list[tuple[str, re.Pattern]]]]]] = {}
        self.wordless: list[tuple[str, re.Pattern]] = []
        for probe in probes:
            pattern = re.compile(r"(?<!\w)" + re.escape(probe) + r"(?!\w)", re.IGNORECASE)
            if not words[probe]:
                self.wordless.append((probe, pattern))
                continue
            word, at = min(words[probe], key=lambda w: (shared[w[0]], -len(w[0])))
            folded = fold(probe)
            self.filed.setdefault(word, {}).setdefault(at, {}).setdefault(len(folded), {}).setdefault(folded, []).append((probe, pattern))

    def counts(self, text: str) -> dict[str, int]:
        out: dict[str, int] = {}
        folded = fold(text)
        present = set(WORD.findall(folded)) & self.filed.keys()
        if present:
            for found in WORD.finditer(folded):
                word = found.group()
                if word not in present:
                    continue
                for at, by_length in self.filed[word].items():
                    start = found.start() - at
                    if start < 0:
                        continue
                    for length, by_text in by_length.items():
                        for probe, pattern in by_text.get(folded[start : start + length], ()):
                            if pattern.match(text, start):
                                out[probe] = out.get(probe, 0) + 1
        for probe, pattern in self.wordless:
            count = len(pattern.findall(text))
            if count:
                out[probe] = count
        return out


def _json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _decoded(path: Path) -> str:
    return path.read_bytes().decode("utf-8", errors="replace")


def _properties(value) -> dict:
    """A graph row's properties (a JSON object in a string)."""
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _rows(connection, query: str) -> Iterator[list]:
    result = connection.execute(query)
    while result.has_next():
        yield result.get_next()


def _vector_tables(root: Path) -> Iterator[tuple[str, list[str]]]:
    """Each LanceDB table's name and the `text` of each of its rows (what Cognee searches)."""
    tables = sorted((root / LANCEDB).glob("*.lance")) if (root / LANCEDB).is_dir() else []
    if not tables:
        return
    import lance

    for table in tables:
        payloads = lance.dataset(str(table)).to_table(columns=["payload"]).column("payload").to_pylist()
        yield table.stem, [p["text"] for p in payloads if isinstance(p, dict) and isinstance(p.get("text"), str)]


def _graph(root: Path) -> tuple[list[tuple[str, str]], set[str]]:
    """The graph's values made from the documents, as (kind, text), and Cognee's own words in it (entity labels and
    relation names)."""
    values: list[tuple[str, str]] = []
    own: set[str] = set()
    if not (root / GRAPH).is_file():
        return values, own
    import ladybug

    database = ladybug.Database(str(root / GRAPH))
    connection = ladybug.Connection(database)
    try:
        for name, kind, properties in _rows(connection, "MATCH (n:Node) RETURN n.name, n.type, n.properties"):
            props = _properties(properties)
            if kind == "EntityType":
                own.add(str(name or ""))
            elif kind == "DocumentChunk":
                values.append(("document", str(props.get("text") or "")))
            elif kind == "Entity":
                values.extend(("document", str(v or "")) for v in (name, props.get("description")))
            elif kind != "TextDocument":  # a document's node is named by its id
                values.extend(("derived", str(v or "")) for v in (name, props.get("text"), props.get("description")))
        for relation, properties in _rows(connection, "MATCH ()-[r:EDGE]->() RETURN r.relationship_name, r.properties"):
            own.add(str(relation or ""))
            values.append(("derived", str(_properties(properties).get("edge_text") or "")))
    finally:
        connection.close()
        database.close()
    return values, own


def content(root: Path) -> tuple[list[tuple[str, str, str]], set[str]]:
    """What the stores under `root` hold that was made from the documents, decoded: (place, kind, text), where kind is
    "document" (the documents' words only) or "derived" (with Cognee's own words too), and Cognee's own labels and
    relation names, as stored."""
    out: list[tuple[str, str, str]] = []
    own: set[str] = set()
    known = {root / RELATIONAL, root / GRAPH}  # SQLite holds names, ids, paths and states (purge vacuums it)
    for path in sorted((root / "text").glob("*.json")):
        known.add(path)
        stored = _json(path)
        if isinstance(stored, dict) and isinstance(stored.get("text"), str):
            out.append((f"text/{path.name}", "document", stored["text"]))  # its name isn't hidden: it isn't text
    known.update((root / "passages").glob("*.json"))  # where each passage is, by id and hash
    known.add(root / "ledger.json")  # which imports made which documents, by id
    facts = _json(root / "facts.json")
    known.add(root / "facts.json")
    for fact in (facts or {}).get("facts", []) if isinstance(facts, dict) else []:
        out.append(("facts.json", "document", str(fact.get("sourceSentence") or "")))
        out.append(("facts.json", "derived", str(fact.get("sentence") or "")))
    if (root / LANCEDB).is_dir():
        known.update(p for p in (root / LANCEDB).rglob("*"))
        for table, texts in _vector_tables(root):
            if table in COGNEE_TABLES:
                own.update(texts)
            elif table not in ID_TABLES:
                out.append((f"LanceDB {table}", "document" if table in DOCUMENT_TABLES else "derived", "\n".join(texts)))
    values, graph_own = _graph(root)
    own.update(graph_own)
    for kind in ("document", "derived"):
        texts = [text for k, text in values if k == kind and text]
        if texts:
            out.append(("graph", kind, "\n".join(texts)))
    for path in sorted(root.rglob("*")):
        if path in known or path.is_symlink() or not path.is_file():
            continue
        name = str(path.relative_to(root))
        if name.startswith(str(RELATIONAL)) or name.startswith(str(GRAPH)) or name.startswith("system/databases/.cognee-migration-"):
            continue  # the databases' own side files (write-ahead logs, locks): checked by purge()
        out.append((name, "document" if name.startswith("documents/") else "derived", _decoded(path)))
    return out, own


def _phrases(labels: Iterable[str]) -> list[tuple[str, ...]]:
    """Cognee's labels and relation names as the words it writes them with, folded: `is_part_of` is (is, part, of)."""
    return [tuple(WORD.findall(fold(label.replace("_", " ")))) for label in labels if label]


def _cognees(probe: str, phrases: list[tuple[str, ...]]) -> bool:
    """Whether `probe` is Cognee's own: one of its labels or relation names, as stored (`headquartered_in`) or as
    written ("headquartered in"), or some of their words in a row ("part of")."""
    words = tuple(WORD.findall(fold(probe.replace("_", " "))))
    return bool(words) and any(phrase[i : i + len(words)] == words for phrase in phrases for i in range(len(phrase) - len(words) + 1))


def left(root: Path, probes: list[str], kept: Callable[[], Iterable[str]]) -> dict[str, int]:
    """The places under `root` still holding removed or hidden text, with how many times: every probe found, except
    one a kept document's text holds too (it may rightly stay, in that document's data), and one of Cognee's own
    words (`_cognees`) found in what holds Cognee's words too. The kept texts are read one at a time."""
    matcher = Matcher(probes)
    exempt: set[str] = set()
    for text in kept():
        exempt.update(matcher.counts(text))
    places, labels = content(root)
    phrases = _phrases(labels)
    out: dict[str, int] = {}
    for place, kind, text in places:
        for probe, count in matcher.counts(text).items():
            if probe in exempt or (kind == "derived" and _cognees(probe, phrases)):
                continue
            out[place] = out.get(place, 0) + count
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


def vector_problems(lancedb_dir: Path) -> list[str]:
    """What keeps deleted data in a LanceDB table after compact_vectors: an older version, a fragment with deleted
    rows, a data or deletion file no fragment of the current version uses."""
    if not lancedb_dir.exists():
        return []
    import lance

    problems = []
    for table in sorted(lancedb_dir.glob("*.lance")):
        dataset = lance.dataset(str(table))
        fragments = [fragment.metadata for fragment in dataset.get_fragments()]
        used = {getattr(file, "path", file) for metadata in fragments for file in metadata.files}
        stored = {path.name for path in (table / "data").glob("*")} if (table / "data").is_dir() else set()
        deletions = [path for path in (table / "_deletions").glob("*")] if (table / "_deletions").is_dir() else []
        if len(dataset.versions()) > 1:
            problems.append(f"{table.stem}: {len(dataset.versions())} versions")
        if any(metadata.deletion_file is not None for metadata in fragments) or deletions:
            problems.append(f"{table.stem}: deleted rows kept")
        if stored - used:
            problems.append(f"{table.stem}: {len(stored - used)} data files no version uses")
    return problems


GRAPH_COUNTS = ("MATCH (n) RETURN COUNT(n)", "MATCH ()-[r]->() RETURN COUNT(r)")


def _graph_statement(path: Path, statement: str) -> tuple[int, ...]:
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
        before = _graph_statement(graph_file, f"EXPORT DATABASE '{export}'")
        after = _graph_statement(rebuilt, f"IMPORT DATABASE '{export}'")
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


def relational_problems(db_file: Path | None) -> list[str]:
    """What keeps deleted rows in SQLite after vacuum_relational: free pages, or pages waiting in its write-ahead log."""
    if db_file is None or not db_file.exists():
        return []
    conn = sqlite3.connect(db_file)
    try:
        free = conn.execute("PRAGMA freelist_count").fetchone()[0]
    finally:
        conn.close()
    wal = Path(f"{db_file}-wal")
    problems = [f"SQLite: {free} free pages"] if free else []
    if wal.exists() and wal.stat().st_size:
        problems.append("SQLite: pages in its write-ahead log")
    return problems


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
    """Every store rewritten without what was deleted, then checked: a store that still keeps an older version, a
    deleted row or a free page raises. Returns what was done, for the job's result."""
    done = {
        "vectorTables": len(compact_vectors(databases_dir / "cognee.lancedb")),
        "graphRebuilt": rebuild_graph(databases_dir / "cognee_graph_ladybug", work),
        "relationalVacuumed": vacuum_relational(relational_db),
        "logsCleared": clear_logs(logs_dir),
    }
    problems = vector_problems(databases_dir / "cognee.lancedb") + relational_problems(relational_db)
    if Path(f"{databases_dir / 'cognee_graph_ladybug'}.wal").exists():
        problems.append("graph: a write-ahead log kept")
    if problems:
        raise RuntimeError("; ".join(problems))
    return done
