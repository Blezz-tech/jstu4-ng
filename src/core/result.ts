/** Successful outcome carrying a value. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed outcome carrying a typed domain error. */
interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Discriminated union representing either a value or a typed error. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful {@link Result}. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed {@link Result}. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Compile-time exhaustiveness guard for discriminated unions (e.g. `switch`
 * over `error.kind`). Throws if reached at runtime via unsafe casts.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
