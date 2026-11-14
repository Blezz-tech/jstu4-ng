import { describe, expect, it } from 'vitest';
import {
  clampMaxSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_SPEED,
  formatSpeed,
  MAX_MAX_SPEED,
  MIN_MAX_SPEED,
  MIN_SPEED,
  stepIntervalMs,
} from '../src/ui/speed';

describe('speed helpers', () => {
  it('clamps max speed into [MIN_MAX_SPEED, MAX_MAX_SPEED] on 0.5 increments', () => {
    expect(clampMaxSpeed(10)).toBe(10);
    expect(clampMaxSpeed(0)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(-5)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(9999)).toBe(MAX_MAX_SPEED);
    expect(clampMaxSpeed(Number.NaN)).toBe(DEFAULT_MAX_SPEED);
    expect(clampMaxSpeed(12.3)).toBe(12.5);
  });

  it('clamps execution speed into [MIN_SPEED, maxSpeed]', () => {
    expect(clampSpeed(1, 10)).toBe(1);
    expect(clampSpeed(0.1, 10)).toBe(MIN_SPEED);
    expect(clampSpeed(15, 10)).toBe(10);
    expect(clampSpeed(25, 50)).toBe(25);
    expect(clampSpeed(Number.NaN, 10)).toBe(DEFAULT_SPEED);
    expect(clampSpeed(2.24, 10)).toBe(2);
    expect(clampSpeed(2.26, 10)).toBe(2.5);
  });

  it('computes step intervals inversely proportional to speed (1× = 200 ms)', () => {
    expect(stepIntervalMs(0.5)).toBe(400);
    expect(stepIntervalMs(1)).toBe(200);
    expect(stepIntervalMs(2)).toBe(100);
    expect(stepIntervalMs(10)).toBe(20);
  });

  it('formats speed multipliers cleanly with × sign', () => {
    expect(formatSpeed(0.5)).toBe('0.5×');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(1.5)).toBe('1.5×');
    expect(formatSpeed(10)).toBe('10×');
  });
});
