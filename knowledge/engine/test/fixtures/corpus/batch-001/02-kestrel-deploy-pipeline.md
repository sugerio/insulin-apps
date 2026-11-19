# Kestrel Deploy Pipeline

Kestrel is the deployment pipeline used by every backend service.

## Canary stage

Every production deploy starts with a canary that receives 5 percent of traffic for 20 minutes. Kestrel compares the canary with the stable fleet during that window.

## Automatic rollback

Kestrel rolls the deploy back automatically when the canary error rate exceeds 2 percent or when p95 latency regresses by more than 30 percent. A rollback pages the service owner.

## Deploy freeze

Production deploys are frozen on Fridays after 15:00 UTC and during the last two weeks of December. Emergency fixes during a freeze need approval from the incident commander.
