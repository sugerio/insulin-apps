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
document's data. All probes are looked for at once (`Matcher`, Aho-Corasick over the text's words and the runs between
them), so the cost is the text's length plus the matches, whatever the probes share.

Where it is looked for (`content()`): only values made from the documents, never keys, schemas or the stores' own
bookkeeping (ids, types, paths, states): the stored texts, Cognee's copies of them, its chunks, entity names, summaries
and relations in LanceDB and the graph, and the facts. Cognee also writes values of its own, from its fixed words
(`ENTITY_LABELS`, `RELATIONS`: in this setup GLiNER picks them from Cognee's label banks, never from a document): an
entity type's name and a relation's name are skipped when they are one of those, and a summary, a relation's text or a
fact's sentence is skipped only when it is exactly what Cognee's template makes from the graph's live records (whose
own values are read where they stand). Anything else, a summary that isn't such, a text that only shares words with a
label, is read in full. Any file under /data this module doesn't know is read whole, as text.

This module never imports Cognee; the databases are opened with their own libraries, after the process that used
Cognee has exited, so nothing else holds them open.
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import sqlite3
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from datetime import timedelta
from pathlib import Path

import facts

PROBE_MIN = 24  # shortest piece of a removed document looked for
DELETED_SHARE = 1e-9  # a fragment with any deleted row is rewritten

# Where a removed text is cut into pieces: line breaks, sentence ends and runs of spaces (a chunker may squeeze them).
CUTS = re.compile(r"\s{2,}|[\t\r\n\f\v\x00-\x1f]|(?<=[.!?])\s")
WORD = re.compile(r"\w+")
TOKEN = re.compile(r"\w+|\W+")  # a text as Matcher reads it: words and the runs between them

LANCEDB = Path("system/databases/cognee.lancedb")
GRAPH = Path("system/databases/cognee_graph_ladybug")
RELATIONAL = Path("system/databases/cognee_db")
# Cognee's own words in this setup, for the version the image pins (a test keeps COGNEE_VERSION equal to it): with no
# LLM, GLiNER draws entity labels and relation names only from Cognee's fixed label banks
# (cognee/tasks/graph/gliner_demo/banks.py, LABEL_BANK and RELATION_BANK), dates become Timestamp nodes, and Cognee links
# its own records with four relations. Never a document's words: a label outside these is read as the document's.
COGNEE_VERSION = "1.6.8"
ENTITY_LABELS = frozenset(
    {
        "person", "organization", "location", "event", "date", "year", "time_period", "product", "technology",
        "software", "programming_language", "concept", "document", "project", "role", "industry", "money", "quantity",
        "percentage", "law", "disease", "drug", "chemical", "animal", "plant", "artwork", "award", "facility",
        "vehicle", "food", "nationality", "Timestamp",
    }
)
RELATIONS = frozenset(
    {
        "works_for", "founded_by", "located_in", "headquartered_in", "part_of", "member_of", "owns", "acquired",
        "produces", "uses", "created_by", "leads", "collaborates_with", "born_in", "participates_in", "occurred_on",
        "contains", "is_a", "is_part_of", "made_from",
    }
)


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
    and whole. Aho-Corasick over the folded text's tokens (its words and the runs between them): each probe, from its
    first word to its last, is a path of tokens in one trie; the text is read once, token by token, following failure
    links, and every end of a probe's path is confirmed with the probe's own expression (its edges included). The cost
    is the text's length plus the matches, whatever the probes share: a word, a prefix, every length."""

    def __init__(self, probes: Iterable[str]) -> None:
        goto: list[dict[str, int]] = [{}]
        ends: list[list[tuple[str, re.Pattern, int, int]]] = [[]]  # per state: (probe, expression, lead, tokens)
        self.wordless: list[tuple[str, re.Pattern]] = []
        self.depth = 1
        for probe in dict.fromkeys(p for p in probes if p):
            pattern = re.compile(r"(?<!\w)" + re.escape(probe) + r"(?!\w)", re.IGNORECASE)
            tokens = TOKEN.findall(fold(probe))
            words = [i for i, token in enumerate(tokens) if WORD.match(token)]
            if not words:
                self.wordless.append((probe, pattern))
                continue
            path = tokens[words[0] : words[-1] + 1]
            state = 0
            for token in path:
                if token not in goto[state]:
                    goto[state][token] = len(goto)
                    goto.append({})
                    ends.append([])
                state = goto[state][token]
            ends[state].append((probe, pattern, sum(len(t) for t in tokens[: words[0]]), len(path)))
            self.depth = max(self.depth, len(path))
        fail = [0] * len(goto)
        found_next = [0] * len(goto)  # the nearest state down the failure links where a probe ends
        queue = deque(goto[0].values())
        while queue:
            state = queue.popleft()
            for token, target in goto[state].items():
                queue.append(target)
                back = fail[state]
                while back and token not in goto[back]:
                    back = fail[back]
                fail[target] = goto[back].get(token, 0) if state else 0
                found_next[target] = fail[target] if ends[fail[target]] else found_next[fail[target]]
        self.goto, self.fail, self.ends, self.found_next = goto, fail, ends, found_next

    def counts(self, text: str) -> dict[str, int]:
        out: dict[str, int] = {}
        goto, fail, ends, found_next = self.goto, self.fail, self.ends, self.found_next
        if len(goto) > 1:
            starts: deque[int] = deque(maxlen=self.depth)  # where the last tokens start
            state = 0
            for token in TOKEN.finditer(fold(text)):
                word = token.group()
                starts.append(token.start())
                while state and word not in goto[state]:
                    state = fail[state]
                state = goto[state].get(word, 0)
                end = state if ends[state] else found_next[state]
                while end:
                    for probe, pattern, lead, length in ends[end]:
                        start = starts[-length] - lead
                        if start >= 0 and pattern.match(text, start):
                            out[probe] = out.get(probe, 0) + 1
                    end = found_next[end]
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


def _graph(root: Path) -> tuple[dict[str, dict], list[tuple[str, str, str, dict]]]:
    """The graph's nodes (id -> name, type, properties) and edges (source, target, relation name, properties)."""
    nodes: dict[str, dict] = {}
    edges: list[tuple[str, str, str, dict]] = []
    if not (root / GRAPH).is_file():
        return nodes, edges
    import ladybug

    database = ladybug.Database(str(root / GRAPH))
    connection = ladybug.Connection(database)
    try:
        for node_id, name, kind, properties in _rows(connection, "MATCH (n:Node) RETURN n.id, n.name, n.type, n.properties"):
            nodes[str(node_id)] = {"name": str(name or ""), "type": str(kind or ""), "props": _properties(properties)}
        query = "MATCH (a:Node)-[r:EDGE]->(b:Node) RETURN a.id, b.id, r.relationship_name, r.properties"
        for source, target, relation, properties in _rows(connection, query):
            edges.append((str(source), str(target), str(relation or ""), _properties(properties)))
    finally:
        connection.close()
        database.close()
    return nodes, edges


def _label(node: dict) -> str:
    """How Cognee names a node in a relation's text (prepare_edges_for_storage.py `_get_node_label`): its first
    indexed field, on one line and cut at 80 characters, else its name, else its type."""
    metadata = node["props"].get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = ast.literal_eval(metadata)
        except (ValueError, SyntaxError):
            metadata = {}
    fields = metadata.get("index_fields") or [] if isinstance(metadata, dict) else []
    for field in fields:
        value = node["name"] if field == "name" else node["props"].get(field)
        value = str(value).strip() if value is not None else ""
        if value:
            return " ".join(value.split())[:80]
    return node["name"].strip() or node["type"]


def _relation_text(source: dict, relation: str, target: dict, text: str) -> bool:
    """Whether `text` is exactly what Cognee writes for this relation: "<source> <relation as words> <target>.", or for
    a chunk's mention of an entity, "Document chunk mentions <name>: <name as the chunk spelled it>"."""
    phrase = relation.strip().replace("_", " ") or "related to"
    if text == f"{_label(source)} {phrase} {_label(target)}.":
        return True
    mention = f"Document chunk mentions {target['name']}: "
    spelled = {fold(target["name"]), fold(str(target["props"].get("description") or ""))}
    return relation == "contains" and text.startswith(mention) and fold(text[len(mention) :]) in spelled


def _summary(text: str, names: set[str]) -> bool:
    """Whether `text` is exactly what Cognee writes as a chunk's summary (gliner_demo/summary.py): a line of
    "<entity> <relation> <entity>" and a line of "<label>: <entity>, <entity>", each part "; "-separated, with only live
    entities' names (`names`, folded) and Cognee's own labels and relation names."""
    lines = text.split("\n")
    return 0 < len(lines) <= 2 and all(_summary_line(line, names) for line in lines)


def _summary_line(line: str, names: set[str]) -> bool:
    def cuts(start: int, separators: tuple[str, ...]) -> set[int]:
        found = {len(line)}
        for separator in separators:
            at = line.find(separator, start)
            while at >= 0:
                found.add(at)
                at = line.find(separator, at + 1)
        return found

    def name_ends(start: int) -> set[int]:
        """Where a list of names ("a, b") from `start` can end."""
        out, todo, seen = set(), {start}, set()
        while todo:
            at = todo.pop()
            if at in seen:
                continue
            seen.add(at)
            for end in cuts(at, ("; ", ", ")):
                if fold(line[at:end]) in names:
                    if line.startswith(", ", end):
                        todo.add(end + 2)
                    out.add(end)
        return out

    def item_ends(start: int) -> set[int]:
        out: set[int] = set()
        for label in ENTITY_LABELS:
            if line.startswith(f"{label}: ", start):
                out |= name_ends(start + len(label) + 2)
        for relation in RELATIONS:
            at = line.find(f" {relation} ", start)
            while at >= 0:
                if fold(line[start:at]) in names:
                    tail = at + len(relation) + 2
                    out |= {end for end in cuts(tail, ("; ",)) if fold(line[tail:end]) in names}
                at = line.find(f" {relation} ", at + 1)
        return out

    done: dict[int, bool] = {}

    def rest(start: int) -> bool:
        if start not in done:
            done[start] = any(end == len(line) or (line.startswith("; ", end) and rest(end + 2)) for end in item_ends(start))
        return done[start]

    return bool(line) and rest(0)


def content(root: Path) -> list[tuple[str, str]]:
    """What the stores under `root` hold that was made from the documents, decoded, as (place, text): everything but
    Cognee's own values (its labels where they stand alone, and texts exactly as its templates make them from the live
    records)."""
    out: list[tuple[str, str]] = []
    known = {root / RELATIONAL, root / GRAPH}  # SQLite holds names, ids, paths and states (purge vacuums it)
    for path in sorted((root / "text").glob("*.json")):
        known.add(path)
        stored = _json(path)
        if isinstance(stored, dict) and isinstance(stored.get("text"), str):
            out.append((f"text/{path.name}", stored["text"]))  # its name isn't hidden: it isn't text
    known.update((root / "passages").glob("*.json"))  # where each passage is, by id and hash
    known.add(root / "ledger.json")  # which imports made which documents, by id

    nodes, edges = _graph(root)
    names = {fold(v) for n in nodes.values() if n["type"] in ("Entity", "Timestamp") for v in (n["name"], str(n["props"].get("description") or "")) if v}
    graph: list[str] = []
    for node in nodes.values():
        props = node["props"]
        if node["type"] == "EntityType":
            graph.extend([] if node["name"] in ENTITY_LABELS else [node["name"]])
        elif node["type"] == "TextSummary":
            text = str(props.get("text") or "")
            graph.extend([] if _summary(text, names) else [text])
        elif node["type"] != "TextDocument":  # a document's node is named by its id
            graph.extend(str(v) for v in (node["name"], props.get("text"), props.get("description")) if v)
    made: set[str] = set()  # relation texts exactly as Cognee writes them
    sentences: set[str] = set()  # facts' sentences as facts.py writes them
    for source, target, relation, props in edges:
        if relation not in RELATIONS:
            graph.append(relation)
        text = str(props.get("edge_text") or "")
        if source in nodes and target in nodes and relation in RELATIONS and _relation_text(nodes[source], relation, nodes[target], text):
            made.add(text)
        elif text:
            graph.append(text)
        if nodes.get(source, {}).get("type") == "Entity" and nodes.get(target, {}).get("type") == "Entity":
            sentences.add(facts.fact_sentence(nodes[source]["name"], relation, nodes[target]["name"]))
    if graph:
        out.append(("graph", "\n".join(graph)))

    known.add(root / "facts.json")
    stored_facts = _json(root / "facts.json")
    for fact in (stored_facts or {}).get("facts", []) if isinstance(stored_facts, dict) else []:
        out.append(("facts.json", str(fact.get("sourceSentence") or "")))
        if str(fact.get("sentence") or "") not in sentences:
            out.append(("facts.json", str(fact.get("sentence") or "")))
    if (root / LANCEDB).is_dir():
        known.update(p for p in (root / LANCEDB).rglob("*"))
        for table, texts in _vector_tables(root):
            if table == "TextDocument_name":
                continue  # documents' ids
            if table == "EntityType_name":
                texts = [t for t in texts if t not in ENTITY_LABELS]
            elif table == "TextSummary_text":
                texts = [t for t in texts if not _summary(t, names)]
            elif table == "EdgeType_relationship_name":
                texts = [t for t in texts if t not in made and t not in RELATIONS]  # a relation's text, or its name
            if texts:
                out.append((f"LanceDB {table}", "\n".join(texts)))
    for path in sorted(root.rglob("*")):
        if path in known or path.is_symlink() or not path.is_file():
            continue
        name = str(path.relative_to(root))
        if name.startswith(str(RELATIONAL)) or name.startswith(str(GRAPH)) or name.startswith("system/databases/.cognee-migration-"):
            continue  # the databases' own side files (write-ahead logs, locks): checked by purge()
        out.append((name, _decoded(path)))
    return out


def left(root: Path, probes: list[str], kept: Callable[[], Iterable[str]]) -> dict[str, int]:
    """The places under `root` still holding removed or hidden text, with how many times: every probe found, except
    one a kept document's text holds too (it may rightly stay, in that document's data). The kept texts are read one
    at a time."""
    matcher = Matcher(probes)
    exempt: set[str] = set()
    for text in kept():
        exempt.update(matcher.counts(text))
    out: dict[str, int] = {}
    for place, text in content(root):
        for probe, count in matcher.counts(text).items():
            if probe not in exempt:
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
