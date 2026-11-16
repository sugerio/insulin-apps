"""Build-time warm-up: download and load the local models Cognee uses when no LLM key is configured, so the running
container never needs the network, and check that the engine's own modules import.

  - GLiNER graph extractor (fastino/gliner2.5-base-v1), via Cognee's own loader
  - fastembed embedding model (BAAI/bge-small-en-v1.5), via Cognee's engine
  - tiktoken encodings, in case a tokenizer path asks for them

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
