import { expect } from 'vitest';
import type { Result } from '../../src/core/result';

export function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected Ok result, got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected Err result, got Ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
