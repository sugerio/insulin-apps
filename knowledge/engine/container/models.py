"""The local models the engine runs, pinned: each Hugging Face repo at one commit, and the SHA-256 of every file the
image keeps from it. Cognee picks the models (GLiNER for facts; fastembed's quantized ONNX build of bge-small-en-v1.5
for the vectors, with the original repo's tokenizer for chunk sizes) and loads them by name, which on its own means
"whatever the repo's main branch holds today". So the build fetches each pinned commit first, points the cache's main
at it, and runs the warm-up offline; afterwards the cache must hold exactly these files and nothing else.

The vectors in a collection's databases come from the embedding model, so its repo and commit are part of
KNOWLEDGE_DATA_FORMAT (the Dockerfile): moving the pin without changing the format fails the build, because backups
written with other vectors must not be copied into this image.

  python models.py fetch    download the pinned commits into the hub cache (needs the network)
  python models.py verify   check the cache against the pins (offline)
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

# repo -> (commit, {path in the repo: sha256 of the file})
MODELS: dict[str, tuple[str, dict[str, str]]] = {
    "fastino/gliner2.5-base-v1": (
        "07d99c0ba5d15cb3b24e0a236fa99bdd4ef87a5c",
        {
            "config.json": "d6b515c21ae2100c12267fb42a3f02c1e99ad87580366aebedb161efd74441c7",
            "encoder_config/config.json": "d36a845b9f25dcaf1ec45a1c4bdf65ea4ac20596537e14530ec9f660a63aeca4",
            "model.safetensors": "7274094de2e0c2a37a386f55fc4e23061a954da5bd7a335e7dfe56f2743c277a",
            "tokenizer.json": "cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3",
            "tokenizer_config.json": "0bf3ea0873234bd9bfdd3853c440395009ac6365a925b91654daed5396d655e1",
        },
    ),
    "Qdrant/bge-small-en-v1.5-onnx-Q": (
        "aa8f8b060edb00e03bfdd08813a2949946c8ba55",
        {
            "config.json": "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd",
            "model_optimized.onnx": "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
            "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
            "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
            "tokenizer_config.json": "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
        },
    ),
    "BAAI/bge-small-en-v1.5": (
        "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
        {
            "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
            "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
        },
    ),
}

# The model whose vectors the databases hold.
EMBEDDING_REPO = "Qdrant/bge-small-en-v1.5-onnx-Q"


def embedding_tag() -> str:
    """How KNOWLEDGE_DATA_FORMAT names the embedding model: its repo's name and the commit's first 7 characters."""
    commit = MODELS[EMBEDDING_REPO][0]
    return f"{EMBEDDING_REPO.split('/')[-1]}@{commit[:7]}"


def repo_dir(cache: Path, repo: str) -> Path:
    return cache / ("models--" + repo.replace("/", "--"))


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(cache: Path) -> None:
    """Downloads each pinned commit's files and makes it the cache's main, so loading by name finds it offline."""
    from huggingface_hub import snapshot_download

    for repo, (commit, files) in MODELS.items():
        snapshot_download(repo_id=repo, revision=commit, allow_patterns=sorted(files), cache_dir=str(cache))
        refs = repo_dir(cache, repo) / "refs"
        refs.mkdir(parents=True, exist_ok=True)
        (refs / "main").write_text(commit)
        print(f"models: {repo}@{commit[:7]} fetched")


def problems(cache: Path, data_format: str | None) -> list[str]:
    """Everything that differs from the pins: an unknown repo, another commit, a missing, extra or changed file."""
    found: list[str] = []
    known = {repo_dir(cache, repo).name: repo for repo in MODELS}
    for entry in sorted(cache.glob("models--*")):
        if entry.name not in known:
            found.append(f"{entry.name}: not a pinned model")
    for repo, (commit, files) in MODELS.items():
        root = repo_dir(cache, repo)
        refs = root / "refs" / "main"
        if not refs.is_file() or refs.read_text().strip() != commit:
            found.append(f"{repo}: main is not {commit}")
        snapshots = sorted(p.name for p in (root / "snapshots").glob("*")) if (root / "snapshots").is_dir() else []
        if snapshots != [commit]:
            found.append(f"{repo}: snapshots {snapshots}, expected only {commit}")
            continue
        snapshot = root / "snapshots" / commit
        present = sorted(str(p.relative_to(snapshot)) for p in snapshot.rglob("*") if p.is_file())
        for path in present:
            if path not in files:
                found.append(f"{repo}: {path} is not pinned")
        for path, expected in files.items():
            if not (snapshot / path).is_file():
                found.append(f"{repo}: {path} is missing")
            elif sha256_of(snapshot / path) != expected:
                found.append(f"{repo}: {path} does not match its checksum")
    if data_format is not None and embedding_tag() not in data_format:
        found.append(f"KNOWLEDGE_DATA_FORMAT {data_format!r} does not name the embedding model {embedding_tag()}")
    return found


def hub_cache() -> Path:
    from huggingface_hub import constants

    return Path(constants.HF_HUB_CACHE)


def main(argv: list[str]) -> None:
    if argv[1:] == ["fetch"]:
        fetch(hub_cache())
    elif argv[1:] == ["verify"]:
        found = problems(hub_cache(), os.environ.get("KNOWLEDGE_DATA_FORMAT", ""))
        if found:
            sys.exit("models: the cache differs from the pins:\n  " + "\n  ".join(found))
        print("models: every model matches its pin")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
