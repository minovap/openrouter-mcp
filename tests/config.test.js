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

  // Hard-cap invariant tests (panel-adopted: GPT-5.5 + DeepSeek-V4-Pro IMPORTANT).
  // Verify getTimeoutMs() never exceeds getMaxTimeoutMs() even when MAX < DEFAULT.
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

  // PLAN-phase I4 adoption — edge cases that Number(raw) accepts as finite:
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

  // Documents the broader Number()-parseable contract (GPT-5.5 IMPORTANT — env is
  // operator-controlled so this is intentional, not a hazard).
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

// Tests for the panel-adopted helper extracted from src/index.js handler in
// the (review) cycle: handler
// validation was untestable inline). Covers the input-domain matrix.
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

// Pure-function tests for the validation
// logic extracted from the live MCP handler + startup guards in src/index.js.
// Tests are pure functions; no MCP runtime harness needed.
import { validateAskModelRequest, validateStartupEnv } from '../src/config.js';

describe('validateStartupEnv', () => {
  test('returns null when both env vars set with non-empty parsed allowlist', () => {
    expect(validateStartupEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_ALLOWED_MODELS: 'm1,m2',
    })).toBeNull();
  });

  test('rejects missing OPENROUTER_API_KEY (empty string treated as missing)', () => {
    const err = validateStartupEnv({
      OPENROUTER_API_KEY: '',
      OPENROUTER_ALLOWED_MODELS: 'm1',
    });
    expect(err).toContain('OPENROUTER_API_KEY environment variable is required');
  });

  test('rejects undefined OPENROUTER_API_KEY', () => {
    const err = validateStartupEnv({
      OPENROUTER_ALLOWED_MODELS: 'm1',
    });
    expect(err).toContain('OPENROUTER_API_KEY environment variable is required');
  });

  test('rejects missing OPENROUTER_ALLOWED_MODELS', () => {
    const err = validateStartupEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
    });
    expect(err).toContain('OPENROUTER_ALLOWED_MODELS environment variable is required');
  });

  test('rejects OPENROUTER_ALLOWED_MODELS that parses to empty (just commas)', () => {
    const err = validateStartupEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_ALLOWED_MODELS: ',,,',
    });
    expect(err).toContain('contains no valid model IDs after parsing');
  });

  test('rejects OPENROUTER_ALLOWED_MODELS that is whitespace-only', () => {
    const err = validateStartupEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_ALLOWED_MODELS: '   ',
    });
    expect(err).toContain('contains no valid model IDs after parsing');
  });

  test('check order: API_KEY before ALLOWED_MODELS', () => {
    const err = validateStartupEnv({});
    expect(err).toContain('OPENROUTER_API_KEY');
    expect(err).not.toContain('OPENROUTER_ALLOWED_MODELS');
  });

  test('accepts trimmed entries even with whitespace padding', () => {
    expect(validateStartupEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_ALLOWED_MODELS: ' m1 , m2 ',
    })).toBeNull();
  });
});

describe('validateAskModelRequest', () => {
  const allowed = new Set(['m1', 'm2', 'm3']);

  test('returns null when request is valid (no fallback_models)', () => {
    expect(validateAskModelRequest(
      { model: 'm1', append_files: ['/path/file.txt'] },
      allowed
    )).toBeNull();
  });

  test('returns null when request is valid (with valid fallback_models)', () => {
    expect(validateAskModelRequest(
      { model: 'm1', append_files: ['/path/file.txt'], fallback_models: ['m2', 'm3'] },
      allowed
    )).toBeNull();
  });

  test('returns null when append_files is the placeholder ([""])', () => {
    // The upstream contract: pass [""] when no files relevant. Length is 1, not 0.
    expect(validateAskModelRequest(
      { model: 'm1', append_files: [''] },
      allowed
    )).toBeNull();
  });

  test('rejects undefined append_files with the canonical message', () => {
    const err = validateAskModelRequest({ model: 'm1' }, allowed);
    expect(err).toContain('Files relevant to the context must be appended');
    expect(err).toContain('pass [""]');
  });

  test('rejects empty array append_files', () => {
    const err = validateAskModelRequest(
      { model: 'm1', append_files: [] },
      allowed
    );
    expect(err).toContain('Files relevant to the context');
  });

  test('rejects model not in allowlist; message includes allowed list', () => {
    const err = validateAskModelRequest(
      { model: 'bogus', append_files: [''] },
      allowed
    );
    expect(err).toContain('Model "bogus" is not allowed');
    expect(err).toContain('m1, m2, m3');
  });

  test('rejects when ANY fallback_models entry is not in allowlist', () => {
    const err = validateAskModelRequest(
      { model: 'm1', append_files: [''], fallback_models: ['m2', 'bogus'] },
      allowed
    );
    expect(err).toContain('fallback_models contains entries not in OPENROUTER_ALLOWED_MODELS');
    expect(err).toContain('bogus');
    expect(err).toContain('m1, m2, m3');
  });

  test('lists ALL invalid fallback_models entries (not just the first)', () => {
    const err = validateAskModelRequest(
      { model: 'm1', append_files: [''], fallback_models: ['x', 'm1', 'y', 'z'] },
      allowed
    );
    expect(err).toContain('x, y, z');
  });

  test('order of validation: append_files before model check', () => {
    // Even with a bad model, append_files error fires first.
    const err = validateAskModelRequest(
      { model: 'bogus', append_files: [] },
      allowed
    );
    expect(err).toContain('Files relevant to the context');
    expect(err).not.toContain('not allowed');
  });

  test('order of validation: model check before fallback check', () => {
    // Bad model + bad fallbacks → model error fires first.
    const err = validateAskModelRequest(
      { model: 'bogus', append_files: [''], fallback_models: ['x'] },
      allowed
    );
    expect(err).toContain('Model "bogus" is not allowed');
    expect(err).not.toContain('fallback_models contains entries');
  });

  test('does NOT mutate inputs', () => {
    const fallbacks = ['m1', 'bogus'];
    const append = ['/file'];
    validateAskModelRequest(
      { model: 'm1', append_files: append, fallback_models: fallbacks },
      allowed
    );
    expect(fallbacks).toEqual(['m1', 'bogus']);
    expect(append).toEqual(['/file']);
  });
});
