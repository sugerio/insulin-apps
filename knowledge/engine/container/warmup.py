"""Build-time warm-up: load the local models Cognee uses when no LLM key is configured, so the running container never
needs the network, and check that the engine's own modules import. The models were fetched at their pinned commits
by models.py, and this runs with the hub offline, so Cognee's loaders find exactly those (models.py verify checks).

  - GLiNER graph extractor (fastino/gliner2.5-base-v1), via Cognee's own loader
  - fastembed embedding model (BAAI/bge-small-en-v1.5, as Qdrant/bge-small-en-v1.5-onnx-Q), via Cognee's engine
  - tiktoken encodings, in case a tokenizer path asks for them (tiktoken checks their hashes itself)

No database is opened: images are often built under amd64 emulation (Rosetta has no AVX2, and LanceDB needs it),
where native database code is not representative. The databases are exercised at runtime on Cloudflare.
"""

import asyncio
import os
import sys

import tiktoken


async def main() -> None:
    if os.getenv("LLM_API_KEY"):
        sys.exit("warmup must run keyless so Cognee selects the local models")
    if os.getenv("HF_HUB_OFFLINE") != "1":
        sys.exit("warmup must run with HF_HUB_OFFLINE=1, after models.py fetch, so only the pinned models load")

    from cognee.tasks.graph.gliner_demo.extractor import DEFAULT_MODEL, load_extractor

    load_extractor(DEFAULT_MODEL)
    print(f"warmup: GLiNER {DEFAULT_MODEL} loaded")

    from cognee.infrastructure.databases.vector.embeddings import get_embedding_engine

    engine = get_embedding_engine()
    result = await engine.embed_text(["The billing gateway listens on port 8443."])
    vectors = getattr(result, "embeddings", result)
    print(f"warmup: {type(engine).__name__} {getattr(engine, 'model', '')} dim={len(vectors[0])}")

    for name in ("cl100k_base", "o200k_base"):
        tiktoken.get_encoding(name)

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import extract, facts, hide, passages, rank  # noqa: F401, E401

    import pypdf  # noqa: F401

    print("warmup ok")


if __name__ == "__main__":
    asyncio.run(main())
