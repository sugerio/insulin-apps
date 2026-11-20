# Gannet Cache Layer

Gannet is the shared in-memory key-value cache.

## Defaults

Keys expire after a default TTL of 600 seconds unless the caller sets a TTL.

## Eviction

When memory is full Gannet evicts keys with the allkeys-lfu policy.

## Topology

Each region runs 3 replicas of the cache. Reads may be served by any replica; writes go to the primary.
