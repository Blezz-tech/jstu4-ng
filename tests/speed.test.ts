import { describe, expect, it } from 'vitest';
import {
  clampMaxSpeed,
  clampMinSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  DEFAULT_SPEED,
  formatSpeed,
  MAX_MAX_SPEED,
  MAX_MIN_SPEED,
  MIN_MAX_SPEED,
  MIN_MIN_SPEED,
  stepIntervalMs,
  zeroRatio,
} from '../src/ui/speed';

describe('speed helpers', () => {
  it('exposes defaults of -15..25 with initial speed 1', () => {
    expect(DEFAULT_MIN_SPEED).toBe(-15);
    expect(DEFAULT_MAX_SPEED).toBe(25);
    expect(DEFAULT_SPEED).toBe(1);
  });

  it('clamps min speed into [MIN_MIN_SPEED, MAX_MIN_SPEED] on 0.5 increments', () => {
    expect(clampMinSpeed(-15)).toBe(-15);
    expect(clampMinSpeed(0)).toBe(MAX_MIN_SPEED);
    expect(clampMinSpeed(10)).toBe(MAX_MIN_SPEED);
    expect(clampMinSpeed(-9999)).toBe(MIN_MIN_SPEED);
    expect(clampMinSpeed(Number.NaN)).toBe(DEFAULT_MIN_SPEED);
    expect(clampMinSpeed(-12.3)).toBe(-12.5);
  });

  it('clamps max speed into [MIN_MAX_SPEED, MAX_MAX_SPEED] on 0.5 increments', () => {
    expect(clampMaxSpeed(25)).toBe(25);
    expect(clampMaxSpeed(0)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(-5)).toBe(MIN_MAX_SPEED);
    expect(clampMaxSpeed(9999)).toBe(MAX_MAX_SPEED);
    expect(clampMaxSpeed(Number.NaN)).toBe(DEFAULT_MAX_SPEED);
    expect(clampMaxSpeed(12.3)).toBe(12.5);
  });

  it('clamps execution speed into [minSpeed, maxSpeed] across negative, zero, and positive values', () => {
    expect(clampSpeed(1, -15, 25)).toBe(1);
    expect(clampSpeed(0, -15, 25)).toBe(0);
    expect(Object.is(clampSpeed(-0.1, -15, 25), 0)).toBe(true);
    expect(clampSpeed(-20, -15, 25)).toBe(-15);
    expect(clampSpeed(30, -15, 25)).toBe(25);
    expect(clampSpeed(-7.26, -15, 25)).toBe(-7.5);
    expect(clampSpeed(2.24, -15, 25)).toBe(2);
    expect(clampSpeed(2.26, -15, 25)).toBe(2.5);
    expect(clampSpeed(Number.NaN, -15, 25)).toBe(DEFAULT_SPEED);
  });

  it('computes step intervals by magnitude and returns Infinity at speed 0', () => {
    expect(stepIntervalMs(0)).toBe(Number.POSITIVE_INFINITY);
    expect(stepIntervalMs(0.5)).toBe(400);
    expect(stepIntervalMs(-0.5)).toBe(400);
    expect(stepIntervalMs(1)).toBe(200);
    expect(stepIntervalMs(-1)).toBe(200);
    expect(stepIntervalMs(2)).toBe(100);
    expect(stepIntervalMs(-10)).toBe(20);
  });

  it('computes the exact relative position of 0 along [minSpeed, maxSpeed]', () => {
    expect(zeroRatio(-15, 25)).toBeCloseTo(0.375);
    expect(zeroRatio(-10, 10)).toBeCloseTo(0.5);
    expect(zeroRatio(-5, 15)).toBeCloseTo(0.25);
  });

  it('formats positive, zero, and negative speed multipliers cleanly with × sign', () => {
    expect(formatSpeed(-15)).toBe('-15×');
    expect(formatSpeed(-0.5)).toBe('-0.5×');
    expect(formatSpeed(-0)).toBe('0×');
    expect(formatSpeed(0)).toBe('0×');
    expect(formatSpeed(0.5)).toBe('0.5×');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(25)).toBe('25×');
  });
});
