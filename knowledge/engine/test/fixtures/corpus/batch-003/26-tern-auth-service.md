# Tern Authentication Service

Tern issues and validates tokens for every internal and public API.

## Tokens

Access tokens expire after 15 minutes. Refresh tokens are valid for 30 days and are rotated on every use.

## Signing keys

Tokens are signed with EdDSA. The signing key is rotated every 45 days, and the previous key stays valid for verification for another 7 days.
