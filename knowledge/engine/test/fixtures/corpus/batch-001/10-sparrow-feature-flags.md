# Sparrow Feature Flags

Sparrow is the internal feature flag service.

## Naming

Flags follow the pattern team.feature.variant, for example discovery.search-v2.treatment.

## Lifecycle

Every flag expires after 60 days. An expired flag keeps its last value but raises a warning in the owning team's dashboard until it is removed from code.

## Kill switches

Kill switch flags propagate to every service in under 30 seconds. Kill switches may be flipped by any on-call engineer without approval.
