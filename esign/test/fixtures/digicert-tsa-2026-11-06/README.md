A real RFC 3161 response from DigiCert's public TSA (http://timestamp.digicert.com), requested on
2026-11-06 for the SHA-256 of `input` (64 random bytes, synthetic) with the nonce `nonce`. The
three values are base64 in `fixture.json` (the source is text only). Used to check that the verifier accepts DigiCert tokens as they are: no
accuracy field, a SHA-384-signed root, and a cross-signed copy of the root in the token.
