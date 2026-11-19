# Cormorant CDN

Cormorant is the content delivery network in front of all static assets.

## Footprint

Cormorant serves traffic from 38 points of presence.

## Caching

The cache key includes the Accept-Encoding header, so compressed and uncompressed responses are cached separately.

## Purging

The purge API accepts at most 500 URLs per call.
