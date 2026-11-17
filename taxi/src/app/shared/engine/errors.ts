/** Thrown for input the engine refuses to interpret: a malformed decimal, an engine input that fails its schema. */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/** Where a rule-file problem is: the file, the entry (a line, a param, a question), and the column in a formula. */
export interface RuleLocation {
  file: string;
  entry?: string;
  column?: number;
}

/** A broken rule file, found when the rules are compiled. The message names the file, the entry and the column. */
export class RuleError extends Error {
  readonly location: RuleLocation;

  constructor(location: RuleLocation, message: string) {
    const where = [location.file, location.entry, location.column === undefined ? undefined : `column ${location.column}`].filter(Boolean).join(", ");
    super(`${where}: ${message}`);
    this.name = "RuleError";
    this.location = location;
  }
}

/** A formula that can't be parsed, at a 1-based column of its text. Rethrown as a RuleError with the file and entry. */
export class FormulaSyntaxError extends Error {
  readonly column: number;

  constructor(column: number, message: string) {
    super(message);
    this.name = "FormulaSyntaxError";
    this.column = column;
  }
}
