# DNS Change Process

Production DNS is hosted with Fernhollow DNS.

## Before a migration

The TTL of every affected record is lowered to 300 seconds at least 24 hours before a migration, so that the change propagates quickly.

## Review

Every DNS change needs a two-person review and a rollback plan in the change ticket.

## After a migration

The TTL is raised back to 3,600 seconds once the migration has been stable for a day.
