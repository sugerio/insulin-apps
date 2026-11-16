# Public API Versioning Guidelines

The public API uses date-based versions such as 2026-07-01.

## Pinning

Each API key is pinned to the version that was current when the key was created. Clients can override the version per request with the Api-Version header.

## Deprecation

A version is supported for at least 180 days after its deprecation is announced. Responses from a deprecated version include a Sunset header with the shutdown date.

## Breaking changes

Removing a field, renaming a field or changing a type is a breaking change and requires a new version.
