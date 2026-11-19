"""Removal for good and stricter hiding reach every store under /data.

Cognee deletes a document's data by marking it deleted: LanceDB keeps the old data files and versions of every table
until they are compacted and cleaned up, the graph database (Ladybug) keeps deleted nodes' strings in its file, and
SQLite keeps deleted rows in free pages. Snapshots and backups copy those files whole. So after a removal for good or a
re-read with stricter hiding, and before anything is saved, `purge()` rewrites each store without what was deleted and
checks that no store keeps an older version, a deleted row or a free page. Then `left()` checks what the stores hold
now, two ways; what either finds fails the job, so nothing is committed or backed up.

Text written from the documents is searched, strictly (`document_texts()`): the stored texts, Cognee's copies of them,
its chunks, its entities' names and the sentences facts were taken from. Looked for (`removed_probes`,
`hidden_probes`): every value the stricter rules hid; for a removed document, every piece of its text (runs of words
between line breaks and sentence ends, at least PROBE_MIN characters). A probe matches as the hiding detector matches a
word: ignoring case exactly as `re.IGNORECASE` does (`fold()`: "Pin" is "pın", "İ" is "i", "ſ" is "s") and whole, with
no letter or digit just before or after it. One that a kept document's text holds too doesn't count: it may rightly
stay, in that document's data (a hiding rule that hides a value only where a label names it leaves its other
occurrences). All probes are looked for at once (`Matcher`), so the cost is the text's length plus the matches.

What Cognee generates from that text (summaries, relations and their texts, entity types, the graph's nodes and edges,
the vectors' rows, facts) isn't searched: it holds Cognee's own words too, and no rule tells them from a document's.
It is checked by identity instead (`stale()`), through the links Cognee keeps: every record must trace back to a live
chunk of a live document, none to a document removed or a chunk a re-read replaced. A record that doesn't is left
over, whatever its text.

This module never imports Cognee; the databases are opened with their own libraries, after the process that used
Cognee has exited, so nothing else holds them open.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from datetime import timedelta
from pathlib import Path
from uuid import NAMESPACE_OID, UUID, uuid5

PROBE_MIN = 24  # shortest piece of a removed document looked for
DELETED_SHARE = 1e-9  # a fragment with any deleted row is rewritten

# Where a removed text is cut into pieces: line breaks, sentence ends and runs of spaces (a chunker may squeeze them).
CUTS = re.compile(r"\s{2,}|[\t\r\n\f\v\x00-\x1f]|(?<=[.!?])\s")

LANCEDB = Path("system/databases/cognee.lancedb")
GRAPH = Path("system/databases/cognee_graph_ladybug")
RELATIONAL = Path("system/databases/cognee_db")
# Cognee's provenance on every graph node and edge: the data item (and chunk) each was made from.
REFERENCE = re.compile(r"source_ref:v\d+:[^:|]+:([^:|]+)(?::([^:|]+))?")


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
_TOKENS: re.Pattern | None = None
WORD_CHARACTER = re.compile(r"\w")


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


def _token_pattern() -> re.Pattern:
    """How Matcher splits a folded text: runs of word characters, and every other character on its own. A character
    whose case class holds word and non-word characters alike (Greek iota and the combining ypogegrammeni, U+0345,
    which iota folds to) stands on its own too, so two texts that fold alike always split alike."""
    global _TOKENS
    if _TOKENS is None:
        classes: dict[int, set[int]] = {}
        for code, folded in _fold_table().items():
            classes.setdefault(folded, {folded}).add(code)
        mixed = sorted(c for members in classes.values() if len({bool(WORD_CHARACTER.match(chr(m))) for m in members}) > 1 for c in members)
        _TOKENS = re.compile("[^\\W" + "".join(re.escape(chr(c)) for c in mixed) + "]+|(?s:.)")
    return _TOKENS


class Matcher:
    """Finds many probes in a text at once, each as the hiding detector finds a word (hide.py `_words`): ignoring case
    and whole. Aho-Corasick over the folded text's tokens (`_token_pattern`): every probe, punctuation included, is one
    path in a trie, and the text is read once, token by token, following failure links. A probe found ends where its
    last token ends and starts its length before (folding keeps lengths); its edges are checked on the text's own
    characters, as `re` checks them (no word character just before or after), never by running its expression again.
    So the cost is the text's length plus the matches, whatever the probes share: a word, a prefix, a run of
    punctuation, every length."""

    def __init__(self, probes: Iterable[str]) -> None:
        tokens_of = _token_pattern()
        goto: list[dict[str, int]] = [{}]
        ends: list[list[tuple[str, int]]] = [[]]  # per state: (probe, its length)
        for probe in dict.fromkeys(p for p in probes if p):
            state = 0
            for token in tokens_of.findall(fold(probe)):
                if token not in goto[state]:
                    goto[state][token] = len(goto)
                    goto.append({})
                    ends.append([])
                state = goto[state][token]
            ends[state].append((probe, len(probe)))
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
        self.tokens_of, self.goto, self.fail, self.ends, self.found_next = tokens_of, goto, fail, ends, found_next

    def counts(self, text: str) -> dict[str, int]:
        out: dict[str, int] = {}
        goto, fail, ends, found_next = self.goto, self.fail, self.ends, self.found_next
        if len(goto) == 1:
            return out
        word = WORD_CHARACTER.match
        size = len(text)
        state = 0
        for found in self.tokens_of.finditer(fold(text)):
            token = found.group()
            while state and token not in goto[state]:
                state = fail[state]
            state = goto[state].get(token, 0)
            end_state = state if ends[state] else found_next[state]
            if not end_state:
                continue
            end = found.end()
            after = end < size and word(text, end)
            while end_state:
                if not after:
                    for probe, length in ends[end_state]:
                        start = end - length
                        if not (start and word(text, start - 1)):
                            out[probe] = out.get(probe, 0) + 1
                end_state = found_next[end_state]
        return out


SPACES = re.compile(r"\s+")


def cognee_name(text: str) -> str:
    """A text as Cognee names the entities mentioned in it: runs of white space as one space (gliner_demo/mapping.py
    `normalize_name`), then lower case without apostrophes (modules/engine/utils/generate_node_name.py). A kept
    "O'Brien Labs" names the entity "obrien labs"."""
    return SPACES.sub(" ", text).strip().lower().replace("'", "")


def unheld(names: Iterable[str], descriptions: Iterable[str], kept: Iterable[str]) -> tuple[set[str], set[str]]:
    """Of entities' names and descriptions, those no kept text holds: a name (Cognee's form of a mention) as Cognee
    would name the kept text's mentions, a description (the mention as written) as written."""
    names, descriptions = set(names), set(descriptions)
    name_matcher, description_matcher = Matcher(names), Matcher(descriptions)
    held_names: set[str] = set()
    held_descriptions: set[str] = set()
    for text in kept:
        held_names.update(name_matcher.counts(cognee_name(text)))
        held_descriptions.update(description_matcher.counts(text))
    return names - held_names, descriptions - held_descriptions


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


def _vector_tables(root: Path) -> Iterator[tuple[str, list[dict]]]:
    """Each LanceDB table's name and its rows: id, the text Cognee searches, and a chunk's data item."""
    tables = sorted((root / LANCEDB).glob("*.lance")) if (root / LANCEDB).is_dir() else []
    if not tables:
        return
    import lance

    for table in tables:
        rows = lance.dataset(str(table)).to_table(columns=["id", "payload"]).to_pylist()
        yield table.stem, [
            {"id": str(row.get("id")), "text": str((row.get("payload") or {}).get("text") or ""), "document_id": (row.get("payload") or {}).get("document_id")}
            for row in rows
        ]


def _graph(root: Path) -> tuple[dict[str, dict], list[dict]]:
    """The graph's nodes (id -> name, type, properties, provenance) and edges (source, target, relation, properties,
    provenance)."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    if not (root / GRAPH).is_file():
        return nodes, edges
    import ladybug

    database = ladybug.Database(str(root / GRAPH))
    connection = ladybug.Connection(database)
    try:
        query = "MATCH (n:Node) RETURN n.id, n.name, n.type, n.properties, n.source_ref_keys"
        for node_id, name, kind, properties, refs in _rows(connection, query):
            nodes[str(node_id)] = {"name": str(name or ""), "type": str(kind or ""), "props": _properties(properties), "refs": str(refs or "")}
        query = "MATCH (a:Node)-[r:EDGE]->(b:Node) RETURN a.id, b.id, r.relationship_name, r.properties, r.source_ref_keys"
        for source, target, relation, properties, refs in _rows(connection, query):
            edges.append({"source": str(source), "target": str(target), "relation": str(relation or ""), "props": _properties(properties), "refs": str(refs or "")})
    finally:
        connection.close()
        database.close()
    return nodes, edges


def _relational(root: Path) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Cognee's data items (id, where its copy of the text is) and its edges' evidence (data item, chunk)."""
    if not (root / RELATIONAL).is_file():
        return [], []
    conn = sqlite3.connect(f"file:{root / RELATIONAL}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        data = [(str(i), str(location or "")) for i, location in conn.execute("SELECT id, raw_data_location FROM data")] if "data" in tables else []
        evidence = [(str(d), str(c or "")) for d, c in conn.execute("SELECT data_id, chunk_id FROM provenance_edge_evidence")] if "provenance_edge_evidence" in tables else []
    finally:
        conn.close()
    return data, evidence


def _id(value) -> str:
    """An id as one string, however a store writes it (with dashes or without)."""
    try:
        return str(UUID(str(value)))
    except ValueError:
        return str(value)


def edge_type_id(text: str) -> str:
    """The id Cognee gives a relation text's row in EdgeType_relationship_name (EdgeType.id_for in Cognee's DataPoint:
    uuid5 of "EdgeType:" and the text in lower case, spaces as underscores, apostrophes dropped)."""
    return str(uuid5(NAMESPACE_OID, "EdgeType:" + text.lower().replace(" ", "_").replace("'", "")))


def document_texts(root: Path, nodes: dict[str, dict], vectors: dict[str, list[dict]], kept_names: set[str] = frozenset()) -> list[tuple[str, str]]:
    """Text written from the documents, as (place, text): searched strictly. Entity names in `kept_names` are Cognee's
    own form of a kept document's mention (`cognee_name`), so they stay out: a removed "OBrien Labs" would otherwise
    find a kept "O'Brien Labs" there. Any file under `root` that no store here covers is read whole."""
    out: list[tuple[str, str]] = []
    for path in sorted((root / "text").glob("*.json")):
        stored = _json(path)
        if isinstance(stored, dict) and isinstance(stored.get("text"), str):
            out.append((f"text/{path.name}", stored["text"]))  # its name isn't hidden: it isn't text
    stored_facts = _json(root / "facts.json")
    for fact in (stored_facts or {}).get("facts", []) if isinstance(stored_facts, dict) else []:
        out.append(("facts.json", str(fact.get("sourceSentence") or "")))  # the chunk's own sentence
    if "DocumentChunk_text" in vectors:
        out.append(("LanceDB DocumentChunk_text", "\n".join(row["text"] for row in vectors["DocumentChunk_text"])))
    if "Entity_name" in vectors:
        out.append(("LanceDB Entity_name", "\n".join(row["text"] for row in vectors["Entity_name"] if row["text"] not in kept_names)))
    graph = []
    for node in nodes.values():
        if node["type"] == "DocumentChunk":
            graph.append(str(node["props"].get("text") or ""))
        elif node["type"] in ("Entity", "Timestamp"):
            name = node["name"] if node["type"] == "Timestamp" or node["name"] not in kept_names else ""
            graph.extend(str(v) for v in (name, node["props"].get("description")) if v)
    if graph:
        out.append(("graph", "\n".join(graph)))
    known = ("text/", "passages/", "chunks/", "documents/", "ledger.json", "facts.json", str(LANCEDB), str(RELATIONAL), str(GRAPH), "system/databases/.cognee-migration-")
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        name = str(path.relative_to(root))
        if name.startswith("documents/") or not name.startswith(known):
            out.append((name, _decoded(path)))  # Cognee's copies of the texts; or a file nothing here knows
    return out


def stale(root: Path, data_id_of: Callable[[str], UUID], nodes: dict[str, dict], edges: list[dict], vectors: dict[str, list[dict]]) -> dict[str, int]:
    """Records Cognee generated that no longer trace back to a live chunk of a live document, by place. The live
    documents are those with a stored text, and their live chunks those their last learning made (/data/chunks, which
    ops.py writes as it indexes their passages): a chunk a re-read replaced keeps its document's data item and names it
    as it did, so only that list tells it from the chunks now. Then, through Cognee's links: a document's node is its
    data item; a live chunk is part of its document's node; a summary is made from a live chunk, an entity is contained
    in one, an entity type is a live entity's; every node and edge names the data items and chunks it was made from
    (at least one, all live); a vector row is a live node's (a relation text's, a live edge's text); a data item and
    its edges' evidence belong to live documents and chunks, and so do the passages and facts."""
    live_documents = {path.stem for path in (root / "text").glob("*.json")}
    live_data = {_id(data_id_of(d)) for d in live_documents}
    learned: dict[str, set[str]] = {}  # data item -> the chunks its document's last learning made
    for document_id in live_documents:
        listed = _json(root / "chunks" / f"{document_id}.json")
        learned[_id(data_id_of(document_id))] = {_id(c) for c in listed} if isinstance(listed, list) else set()
    out: dict[str, int] = {}

    def left_over(place: str, count: int = 1) -> None:
        out[place] = out.get(place, 0) + count

    links: dict[str, dict[str, set[str]]] = {}
    for edge in edges:
        links.setdefault(edge["relation"], {}).setdefault(edge["source"], set()).add(edge["target"])
    targets_of = lambda relation, node_id: links.get(relation, {}).get(node_id, set())  # noqa: E731
    sources: dict[str, dict[str, set[str]]] = {}
    for edge in edges:
        sources.setdefault(edge["relation"], {}).setdefault(edge["target"], set()).add(edge["source"])

    documents = {i for i, n in nodes.items() if n["type"] == "TextDocument" and _id(i) in live_data}
    chunks = {
        i
        for i, n in nodes.items()
        if n["type"] == "DocumentChunk" and any(_id(i) in learned.get(_id(d), set()) for d in targets_of("is_part_of", i) & documents)
    }
    entities = {i for i, n in nodes.items() if n["type"] in ("Entity", "Timestamp") and sources.get("contains", {}).get(i, set()) & chunks}
    live = documents | chunks | entities
    live |= {i for i, n in nodes.items() if n["type"] == "TextSummary" and targets_of("made_from", i) & chunks}
    live |= {i for i, n in nodes.items() if n["type"] == "EntityType" and sources.get("is_a", {}).get(i, set()) & entities}
    live_chunks = {_id(c) for c in chunks}

    def traced(refs: str) -> bool:
        found = REFERENCE.findall(refs)
        return bool(found) and all(_id(data) in live_data and (not chunk or _id(chunk) in live_chunks) for data, chunk in found)

    known_types = {"TextDocument", "DocumentChunk", "Entity", "Timestamp", "TextSummary", "EntityType"}
    for node_id, node in nodes.items():
        if (node["type"] in known_types and node_id not in live) or not traced(node["refs"]):
            left_over("graph")
    edge_texts = set()
    for edge in edges:
        if edge["source"] not in nodes or edge["target"] not in nodes or not traced(edge["refs"]):
            left_over("graph")
        text = str(edge["props"].get("edge_text") or "").strip() or edge["relation"].strip()
        edge_texts.add(edge_type_id(text))
    live_nodes = {_id(i) for i in live} | {_id(i) for i, n in nodes.items() if n["type"] not in known_types and traced(n["refs"])}
    for table, rows in vectors.items():
        if table.startswith("EdgeType_"):
            count = sum(1 for row in rows if _id(row["id"]) not in edge_texts)
        else:
            count = sum(1 for row in rows if _id(row["id"]) not in live_nodes)
            if table == "DocumentChunk_text":
                count += sum(1 for row in rows if _id(row["document_id"]) not in live_data)
        if count:
            left_over(f"LanceDB {table}", count)
    data, evidence = _relational(root)
    used_copies = set()
    for data_id, location in data:
        if _id(data_id) not in live_data:
            left_over("SQLite data", 1)
        else:
            used_copies.add(location.replace("file://", ""))
    stray = sum(1 for d, c in evidence if _id(d) not in live_data or (c and _id(c) not in live_chunks))
    if stray:
        left_over("SQLite provenance_edge_evidence", stray)
    for path in sorted((root / "documents").glob("*")) if (root / "documents").is_dir() else []:
        if path.is_file() and str(path) not in used_copies and f"/data/{path.relative_to(root)}" not in used_copies:
            left_over(f"documents/{path.name}")
    passages = set()
    for path in sorted((root / "chunks").glob("*.json")) if (root / "chunks").is_dir() else []:
        if path.stem not in live_documents:
            left_over(f"chunks/{path.name}")
    for path in sorted((root / "passages").glob("*.json")) if (root / "passages").is_dir() else []:
        index = _json(path) or []
        passages.update(p.get("passageId") for p in index if isinstance(p, dict))
        if path.stem not in live_documents or any(isinstance(p, dict) and _id(p.get("passageId")) not in live_chunks for p in index):
            left_over(f"passages/{path.name}")
    stored_facts = _json(root / "facts.json")
    for fact in (stored_facts or {}).get("facts", []) if isinstance(stored_facts, dict) else []:
        if fact.get("documentId") not in live_documents or fact.get("passageId") not in passages:
            left_over("facts.json")
    return out


def left(root: Path, probes: list[str], kept: Callable[[], Iterable[str]], data_id_of: Callable[[str], UUID]) -> dict[str, int]:
    """The places under `root` still holding removed or hidden text: the document text holding a probe, with how many
    times (a probe a kept document's text holds too doesn't count, nor an entity name Cognee made from a kept
    document's mention), and the generated records that no longer trace back to a live chunk of a live document, with
    how many. The kept texts are read one at a time."""
    matcher = Matcher(probes)
    nodes, edges = _graph(root)
    vectors = dict(_vector_tables(root))
    names = {n["name"] for n in nodes.values() if n["type"] == "Entity" and n["name"]} | {r["text"] for r in vectors.get("Entity_name", [])}
    name_matcher = Matcher(names)
    exempt: set[str] = set()
    kept_names: set[str] = set()
    for text in kept():
        exempt.update(matcher.counts(text))
        kept_names.update(name_matcher.counts(cognee_name(text)))
    out = stale(root, data_id_of, nodes, edges, vectors)
    for place, text in document_texts(root, nodes, vectors, kept_names):
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
