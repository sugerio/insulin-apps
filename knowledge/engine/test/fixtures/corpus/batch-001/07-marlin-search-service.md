# Marlin Search Service

Marlin powers product search across all catalogues.

## Ranking

Marlin retrieves candidates with BM25 and reranks the top 200 results with a vector model. Merchandising boosts are applied after reranking.

## Indexing

The full search index is rebuilt every night at 02:30 UTC. Incremental updates stream in through the change feed within about 40 seconds. The index is split into 12 shards with two replicas each.

## Ownership

Marlin is owned by the Discovery team. Relevance experiments must be registered in the experiment tracker before they reach production.
