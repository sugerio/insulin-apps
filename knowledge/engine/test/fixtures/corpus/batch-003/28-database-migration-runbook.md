# Database Migration Runbook

Schema migrations are run with the Tidewright migration tool.

## Expand and contract

Migrations follow the expand-contract pattern. Every migration must stay backward compatible with the previous 2 releases of the application.

## Locks

Tidewright sets a lock timeout of 3 seconds so that a migration never blocks production traffic for long. A migration that cannot take its lock is retried later.
