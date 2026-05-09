import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import { getTimeoutMs, getMaxTimeoutMs, getAllowedModels, getInvalidFallbackEntries } from '../src/config.js';

describe('getTimeoutMs', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.OPENROUTER_TIMEOUT_MS;
    delete process.env.OPENROUTER_MAX_TIMEOUT_MS;
  });
  afterAll(() => { process.env = ENV; });

  test('returns default 120000 when env unset', () => {
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('returns env value when valid', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '300000';
    expect(getTimeoutMs()).toBe(300_000);
  });

  test('falls back to default on non-numeric', () => {
    process.env.OPENROUTER_TIMEOUT_MS = 'abc';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('rejects below minimum (1000)', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '500';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('rejects above default maximum (600000)', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '700000';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('accepts boundary values within default cap', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '1000';
    expect(getTimeoutMs()).toBe(1_000);
    process.env.OPENROUTER_TIMEOUT_MS = '600000';
    expect(getTimeoutMs()).toBe(600_000);
  });

  test('honors OPENROUTER_MAX_TIMEOUT_MS override (raises cap)', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '900000';
    process.env.OPENROUTER_TIMEOUT_MS = '700000';
    expect(getTimeoutMs()).toBe(700_000);
  });

  test('honors OPENROUTER_MAX_TIMEOUT_MS override (lowers cap above default; explicit env out-of-bounds → fallback)', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '480000';
    process.env.OPENROUTER_TIMEOUT_MS = '500000';
    // 500000 > new cap 480000 → fallback to safeDefault(480000) = min(120000, 480000) = 120000
    expect(getTimeoutMs()).toBe(120_000);
  });

  // Hard-cap invariant tests: getTimeoutMs() never exceeds getMaxTimeoutMs() even when MAX < DEFAULT.
  test('clamps default to max when MAX < DEFAULT_TIMEOUT_MS, env unset', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '60000';  // 60s — below 120s default
    // env unset → would normally return 120000, but max=60000 → safeDefault clamps to 60000
    expect(getTimeoutMs()).toBe(60_000);
  });

  test('clamps default to max when MAX < DEFAULT_TIMEOUT_MS, explicit env > MAX', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '60000';
    process.env.OPENROUTER_TIMEOUT_MS = '90000';  // 90s — exceeds new cap
    // out-of-bounds → fallback to safeDefault(60000) = min(120000, 60000) = 60000
    expect(getTimeoutMs()).toBe(60_000);
  });

  test('clamps default to max when MAX < DEFAULT_TIMEOUT_MS, env invalid', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '60000';
    process.env.OPENROUTER_TIMEOUT_MS = 'bogus';
    expect(getTimeoutMs()).toBe(60_000);
  });

  test('returns explicit env value when MAX < DEFAULT_TIMEOUT_MS but env in-range', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '60000';
    process.env.OPENROUTER_TIMEOUT_MS = '30000';  // valid: 1000 <= 30000 <= 60000
    expect(getTimeoutMs()).toBe(30_000);
  });

  // Edge cases that Number(raw) accepts as finite:
  test('rejects negative numbers', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '-1';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('rejects Infinity', () => {
    process.env.OPENROUTER_TIMEOUT_MS = 'Infinity';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('rejects decimals (timeouts are integer ms)', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '300000.5';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('rejects scientific notation that parses to non-number', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '3e5.5';
    expect(getTimeoutMs()).toBe(120_000);
  });

  test('accepts scientific notation that parses to integer', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '3e5';  // = 300000
    expect(getTimeoutMs()).toBe(300_000);
  });

  test('accepts whitespace-padded integer values', () => {
    process.env.OPENROUTER_TIMEOUT_MS = ' 300000 ';
    expect(getTimeoutMs()).toBe(300_000);
  });

  // Documents the broader Number()-parseable contract — env is operator-controlled
  // so this is intentional, not a hazard.
  test('accepts hex notation (0x493e0 = 300000)', () => {
    process.env.OPENROUTER_TIMEOUT_MS = '0x493e0';
    expect(getTimeoutMs()).toBe(300_000);
  });
});

describe('getMaxTimeoutMs', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.OPENROUTER_MAX_TIMEOUT_MS;
  });
  afterAll(() => { process.env = ENV; });

  test('returns default 600000 when env unset', () => {
    expect(getMaxTimeoutMs()).toBe(600_000);
  });

  test('returns env value when valid', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '480000';
    expect(getMaxTimeoutMs()).toBe(480_000);
  });

  test('falls back to default on non-numeric', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = 'abc';
    expect(getMaxTimeoutMs()).toBe(600_000);
  });

  test('rejects below minimum', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '500';
    expect(getMaxTimeoutMs()).toBe(600_000);
  });

  test('rejects decimals', () => {
    process.env.OPENROUTER_MAX_TIMEOUT_MS = '300000.5';
    expect(getMaxTimeoutMs()).toBe(600_000);
  });
});

describe('getAllowedModels', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.OPENROUTER_ALLOWED_MODELS;
  });
  afterAll(() => { process.env = ENV; });

  test('returns empty set when env unset (parser contract; runtime enforcement is separate)', () => {
    expect(getAllowedModels().size).toBe(0);
  });

  test('parses comma-separated list', () => {
    process.env.OPENROUTER_ALLOWED_MODELS = 'm1,m2,m3';
    const allowed = getAllowedModels();
    expect(allowed.has('m1')).toBe(true);
    expect(allowed.has('m2')).toBe(true);
    expect(allowed.has('m3')).toBe(true);
    expect(allowed.size).toBe(3);
  });

  test('trims whitespace around entries', () => {
    process.env.OPENROUTER_ALLOWED_MODELS = ' m1 , m2 ,  m3  ';
    const allowed = getAllowedModels();
    expect(allowed.has('m1')).toBe(true);
    expect(allowed.has('m2')).toBe(true);
    expect(allowed.has('m3')).toBe(true);
  });

  test('skips empty entries from trailing/double commas', () => {
    process.env.OPENROUTER_ALLOWED_MODELS = 'm1,,m2,';
    const allowed = getAllowedModels();
    expect(allowed.size).toBe(2);
    expect(allowed.has('')).toBe(false);
  });
});

describe('getInvalidFallbackEntries', () => {
  const allowed = new Set(['m1', 'm2', 'm3']);

  test('returns empty array when fallback_models is undefined', () => {
    expect(getInvalidFallbackEntries(undefined, allowed)).toEqual([]);
  });

  test('returns empty array when fallback_models is null', () => {
    expect(getInvalidFallbackEntries(null, allowed)).toEqual([]);
  });

  test('returns empty array when fallback_models is empty', () => {
    expect(getInvalidFallbackEntries([], allowed)).toEqual([]);
  });

  test('returns empty array when allowedModels is undefined (defensive)', () => {
    expect(getInvalidFallbackEntries(['anything'], undefined)).toEqual([]);
  });

  test('returns empty array when allowedModels is empty Set (defensive)', () => {
    expect(getInvalidFallbackEntries(['anything'], new Set())).toEqual([]);
  });

  test('returns empty array when all entries are valid', () => {
    expect(getInvalidFallbackEntries(['m1', 'm2'], allowed)).toEqual([]);
  });

  test('returns the single invalid entry when one is bad', () => {
    expect(getInvalidFallbackEntries(['m1', 'bogus', 'm2'], allowed)).toEqual(['bogus']);
  });

  test('returns all invalid entries in original order', () => {
    expect(getInvalidFallbackEntries(['x', 'm1', 'y', 'm2', 'z'], allowed)).toEqual(['x', 'y', 'z']);
  });

  test('matches case-sensitively (M1 != m1)', () => {
    expect(getInvalidFallbackEntries(['M1'], allowed)).toEqual(['M1']);
  });

  test('does NOT mutate the input array', () => {
    const input = ['m1', 'bogus'];
    getInvalidFallbackEntries(input, allowed);
    expect(input).toEqual(['m1', 'bogus']);
  });
});
