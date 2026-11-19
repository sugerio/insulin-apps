"""Facts a person can check: each graph relation Cognee extracted, as a sentence, next to the sentence it came from.

The graph query depends on how Cognee stores GLiNER's entities and relations (Ladybug: one Node table, one EDGE
table with relationship_name). It is written defensively and is checked for real only in the Engine lane (Q9);
the sentence building below is plain Python and tested here.
"""

from __future__ import annotations

import hashlib
import json
import re

SKIP_RELATIONS = {"contains", "is_part_of", "is_a", "made_from", "belongs_to_set", "mentioned_in", "has_summary"}
SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9“\"(])")


def fact_sentence(source: str, relation: str, target: str) -> str:
    words = relation.replace("_", " ").strip().lower()
    sentence = f"{source.strip()} {words} {target.strip()}".strip()
    return sentence[:1].upper() + sentence[1:] + ("" if sentence.endswith(".") else ".")


def sentences(text: str) -> list[str]:
    out = []
    for block in text.split("\n"):
        out.extend(s.strip() for s in SENTENCE_END.split(block) if s.strip())
    return out


def source_sentence(chunk_text: str, names: list[str]) -> str | None:
    """The sentence of the chunk that names the most of `names` (first one on a tie)."""
    best, best_score = None, 0
    lowered = [n.lower() for n in names if n]
    for sentence in sentences(chunk_text):
        score = sum(1 for n in lowered if n in sentence.lower())
        if score > best_score:
            best, best_score = sentence, score
    return best


def fact_id(document_id: str, sentence: str) -> str:
    return "f_" + hashlib.sha256(f"{document_id}\0{sentence}".encode()).hexdigest()[:20]


def build(relations: list[dict], chunks: dict[str, dict], passages: dict[str, dict]) -> list[dict]:
    """relations: [{source, relation, target, chunkId}]; chunks: id -> {text}; passages: chunk id -> passage."""
    out, seen = [], set()
    for rel in relations:
        if rel.get("relation") in SKIP_RELATIONS or not rel.get("source") or not rel.get("target"):
            continue
        chunk = chunks.get(str(rel.get("chunkId")))
        passage = passages.get(str(rel.get("chunkId")))
        if not chunk or not passage:
            continue
        sentence = fact_sentence(rel["source"], rel["relation"], rel["target"])
        source = source_sentence(chunk.get("text") or "", [rel["source"], rel["target"]])
        if not source:
            continue
        key = (passage["documentId"], sentence.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "factId": fact_id(passage["documentId"], sentence),
                "sentence": sentence,
                "documentId": passage["documentId"],
                "passageId": passage["passageId"],
                "sourceSentence": source,
                "textHash": passage["textHash"],
            }
        )
    return out


def relations_from_graph(rows: list, chunk_rows: list) -> tuple[list[dict], dict[str, dict]]:
    """Turns the graph query's rows into relations with the chunk that mentions both ends, and chunk texts."""
    mentions: dict[str, set[str]] = {}
    chunks: dict[str, dict] = {}
    for chunk_id, properties, entity_id in chunk_rows:
        mentions.setdefault(str(entity_id), set()).add(str(chunk_id))
        if str(chunk_id) not in chunks:
            try:
                props = json.loads(properties) if isinstance(properties, str) else (properties or {})
            except ValueError:
                props = {}
            chunks[str(chunk_id)] = {"text": props.get("text") or ""}
    relations = []
    for source_id, source_name, relation, target_id, target_name in rows:
        shared = mentions.get(str(source_id), set()) & mentions.get(str(target_id), set())
        either = shared or mentions.get(str(source_id), set())
        for chunk_id in sorted(either)[:1]:
            relations.append({"source": source_name, "relation": relation, "target": target_name, "chunkId": chunk_id})
    return relations, chunks
