/**
 * A validation-result type used consistently across services.
 *
 * The system follows a validate-reject-retain discipline: invalid input is
 * rejected with a specific message and the last known-good persisted value is
 * retained. `Result<T>` makes both outcomes explicit at the type level so
 * callers must handle the error branch.
 */

/** Successful outcome carrying a value. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed outcome carrying a human-readable message and optional error code. */
export interface Err {
  readonly ok: false;
  readonly error: string;
  /** Stable machine-readable code for programmatic handling, when useful. */
  readonly code?: ResultErrorCode;
}

/** Discriminated union of success/failure. */
export type Result<T> = Ok<T> | Err;

/**
 * Well-known error codes surfaced by the domain services. String messages
 * remain the primary carrier of detail; codes let callers branch reliably.
 */
export type ResultErrorCode =
  | 'OUT_OF_RANGE'
  | 'NOT_INTEGER'
  | 'EMPTY'
  | 'DUPLICATE'
  | 'INPUTS_UNAVAILABLE'
  | 'INVALID'
  | 'INCOMPLETE_CONFIGURATION'
  | 'PLAYER_CUT'
  | 'PERSISTENCE_FAILED'
  | 'NOT_FOUND';

/** Construct a success result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failure result. */
export function err(error: string, code?: ResultErrorCode): Err {
  return code === undefined ? { ok: false, error } : { ok: false, error, code };
}

/** Type guard narrowing a Result to its success branch. */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

/** Type guard narrowing a Result to its failure branch. */
export function isErr<T>(result: Result<T>): result is Err {
  return !result.ok;
}
