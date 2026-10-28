/**
 * Thrown for input the engine refuses to interpret: a malformed decimal or date, a payload that fails its schema, a
 * reference to a row that doesn't exist. Ledger facts that break an invariant are not thrown; replay reports them as
 * violations so the writer can show every problem at once (the design rules).
 */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}
