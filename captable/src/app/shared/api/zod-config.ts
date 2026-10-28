import { z } from "zod";

// zod 4 JIT-compiles object parsers with `new Function`, probing for it when the first object schema is built. Neither
// runtime allows that: the web CSP has no 'unsafe-eval' and Workers forbid code generation from strings. Every API
// The namespace index imports this file first, so the setting precedes every schema definition.
z.config({ jitless: true });
