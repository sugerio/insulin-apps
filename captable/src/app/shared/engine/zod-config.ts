import { z } from "zod";

// zod 4 JIT-compiles object parsers with `new Function`. Neither runtime that runs the engine allows that: the web CSP
// has no 'unsafe-eval' and Workers forbid code generation from strings. Every engine module that builds schemas
// The namespace index imports this file first, so the setting precedes every schema definition.
z.config({ jitless: true });
