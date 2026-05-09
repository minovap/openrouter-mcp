// Unit tests for callWithFallbacks (T8) — chain semantics + isTransientSdkError
// classification + structured logging. Mocks the @openrouter/sdk module at the
// SDK boundary; the real `@openrouter/sdk/models/errors` sub-path remains
// unmocked so `instanceof` checks in src/index.js match the typed-error
// instances constructed below.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as errors from '@openrouter/sdk/models/errors';

// src/index.js exits 1 at module init when these env vars are unset.
// Set BEFORE the dynamic import resolves the module body.
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_ALLOWED_MODELS = 'm1,m2,m3';

// jest.unstable_mockModule is NOT hoisted (unlike CJS jest.mock) — the
// registration must run before the dynamic import below. The factory
// returns OpenRouter only; sub-path imports (errors module) bypass it.
const mockSend = jest.fn();
jest.unstable_mockModule('@openrouter/sdk', () => ({
  OpenRouter: jest.fn().mockImplementation(() => ({
    chat: { send: mockSend },
  })),
}));

// Top-level await is fine in ESM. Resolves once src/index.js evaluates,
// including its server.connect(transport) — the StdioServerTransport
// installs stdin listeners but does not block the import promise.
const { callWithFallbacks, askModelHandler } = await import('../src/index.js');

const validReply = { id: 'r1', choices: [{ message: { content: 'ok' } }] };

// SDK error fixtures —
// The Speakeasy-generated *ResponseError classes have constructor
// signature (err, httpMeta), where httpMeta.response.status drives
// the auto-assigned `.statusCode` field on the instance. The base
// OpenRouterDefaultError takes (message, httpMeta) on the same shape.
// Client-side errors (RequestTimeoutError, RequestAbortedError,
// ConnectionError) extend HTTPClientError and accept (message, opts?).
function makeHttpMeta(status, body = '') {
  return {
    response: {
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
    },
    body,
  };
}

function makeTypedResponseError(Cls, status, message) {
  return new Cls({ error: { message } }, makeHttpMeta(status));
}

let errorSpy;
beforeEach(() => {
  mockSend.mockReset();
  // Suppress + capture console.error so structured-log noise from the
  // helper-under-test doesn't leak into Jest output, and so individual
  // tests can assert on the captured arguments.
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('callWithFallbacks', () => {

  describe('happy path', () => {
    test('returns primary response when primary succeeds', async () => {
      mockSend.mockResolvedValue(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].model).toBe('m1');
      // timeoutMs is wired from getTimeoutMs() — assert it's a positive integer.
      expect(mockSend.mock.calls[0][1]).toEqual(
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      expect(mockSend.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
    });
  });

  describe('falls through on transient SDK errors', () => {
    // Client-side transients —
    test('RequestTimeoutError (client-side timeout)', async () => {
      mockSend
        .mockRejectedValueOnce(new errors.RequestTimeoutError('timed out'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[1][0].model).toBe('m2');
    });

    test('RequestAbortedError (client-side abort)', async () => {
      mockSend
        .mockRejectedValueOnce(new errors.RequestAbortedError('aborted'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('ConnectionError (network failure)', async () => {
      mockSend
        .mockRejectedValueOnce(new errors.ConnectionError('network down'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    // Server-side typed transients —
    test('RequestTimeoutResponseError (HTTP 408)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.RequestTimeoutResponseError, 408, 'request timeout'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('TooManyRequestsResponseError (HTTP 429)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.TooManyRequestsResponseError, 429, 'rate limited'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    test('InternalServerResponseError (HTTP 500)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.InternalServerResponseError, 500, 'boom'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    test('BadGatewayResponseError (HTTP 502)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.BadGatewayResponseError, 502, 'bad gateway'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    test('ServiceUnavailableResponseError (HTTP 503)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, 'down'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    test('EdgeNetworkTimeoutResponseError (Cloudflare 524)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.EdgeNetworkTimeoutResponseError, 524, 'cf 524'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    test('ProviderOverloadedResponseError (529 — model overloaded)', async () => {
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.ProviderOverloadedResponseError, 529, 'overloaded'))
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
    });

    // Untyped 5xx via OpenRouterDefaultError + statusCode (DESIGN N1) —
    test('untyped 5xx via OpenRouterDefaultError statusCode 522 (Cloudflare)', async () => {
      const e522 = new errors.OpenRouterDefaultError('Cloudflare 522', makeHttpMeta(522));
      mockSend
        .mockRejectedValueOnce(e522)
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
      // statusCode is auto-assigned from httpMeta.response.status by the SDK constructor.
      expect(e522.statusCode).toBe(522);
    });

    // 504 Gateway Timeout — verified there is NO typed GatewayTimeoutResponseError
    // in @openrouter/sdk/models/errors (only 408/502/503/524/529 typed); a 504
    // surfaces as OpenRouterDefaultError with statusCode=504, covered by the same
    // `statusCode >= 500` branch as the 522 case. Covered by
    // review (Grok-4.20 + GPT-5.5 raised the concern; this test demonstrates
    // the existing branch handles it).
    test('untyped 5xx via OpenRouterDefaultError statusCode 504 (Gateway Timeout)', async () => {
      const e504 = new errors.OpenRouterDefaultError('Gateway Timeout', makeHttpMeta(504));
      mockSend
        .mockRejectedValueOnce(e504)
        .mockResolvedValueOnce(validReply);
      const res = await callWithFallbacks('m1', ['m2'], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(e504.statusCode).toBe(504);
    });
  });

  describe('fail-fast on terminal errors (PLAN-phase I3 — programmer-error policy)', () => {
    test('does NOT retry on TypeError (programmer error)', async () => {
      mockSend.mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));
      await expect(callWithFallbacks('m1', ['m2'], { messages: [] }))
        .rejects.toThrow('Cannot read properties of undefined');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry on NotFoundResponseError (404 — wrong model id)', async () => {
      const e404 = makeTypedResponseError(errors.NotFoundResponseError, 404, 'unknown model');
      mockSend.mockRejectedValueOnce(e404);
      await expect(callWithFallbacks('bogus-model', ['m2'], { messages: [] }))
        .rejects.toBeInstanceOf(errors.NotFoundResponseError);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry on untyped 4xx via OpenRouterDefaultError statusCode 401', async () => {
      const e401 = new errors.OpenRouterDefaultError('Unauthorized', makeHttpMeta(401));
      mockSend.mockRejectedValueOnce(e401);
      await expect(callWithFallbacks('m1', ['m2'], { messages: [] }))
        .rejects.toBe(e401);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('chain semantics', () => {
    test('throws last error when all fallbacks exhausted', async () => {
      mockSend.mockRejectedValue(makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, 'still down'));
      await expect(callWithFallbacks('m1', ['m2', 'm3'], { messages: [] }))
        .rejects.toBeInstanceOf(errors.ServiceUnavailableResponseError);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    test('handles empty fallback_models array (legacy mode, primary only)', async () => {
      mockSend.mockResolvedValue(validReply);
      const res = await callWithFallbacks('m1', [], { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('handles undefined fallback_models (no array passed)', async () => {
      mockSend.mockResolvedValue(validReply);
      const res = await callWithFallbacks('m1', undefined, { messages: [] });
      expect(res.id).toBe('r1');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry past the last chain entry even when last error is transient', async () => {
      // Three rejections, two fallbacks → all three attempts made; last error propagates.
      const final = makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, 'attempt-3-down');
      mockSend
        .mockRejectedValueOnce(makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, '1-down'))
        .mockRejectedValueOnce(makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, '2-down'))
        .mockRejectedValueOnce(final);
      await expect(callWithFallbacks('m1', ['m2', 'm3'], { messages: [] }))
        .rejects.toBe(final);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('structured logging', () => {
    // Helper: extract JSON-parseable lines from console.error mock calls.
    // Filters out any non-JSON noise so the test only inspects fallback events.
    function jsonLines() {
      return errorSpy.mock.calls
        .map(c => c[0])
        .filter(arg => {
          if (typeof arg !== 'string') return false;
          try { JSON.parse(arg); return true; } catch { return false; }
        });
    }

    test('emits one JSON line on fallback with from/to/reason/message/ts fields', async () => {
      mockSend
        .mockRejectedValueOnce(new errors.RequestTimeoutError('timeout'))
        .mockResolvedValueOnce(validReply);
      await callWithFallbacks('m1', ['m2'], { messages: [] });
      const lines = jsonLines();
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.event).toBe('fallback');
      expect(parsed.from).toBe('m1');
      expect(parsed.to).toBe('m2');
      expect(parsed.reason).toBe('RequestTimeoutError');
      expect(parsed.message).toContain('timeout');
      // ts is an ISO timestamp string —
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test('includes statusCode field when the error carries one', async () => {
      const e503 = makeTypedResponseError(errors.ServiceUnavailableResponseError, 503, 'service down');
      mockSend
        .mockRejectedValueOnce(e503)
        .mockResolvedValueOnce(validReply);
      await callWithFallbacks('m1', ['m2'], { messages: [] });
      const fallbackLine = jsonLines()
        .map(l => JSON.parse(l))
        .find(p => p.event === 'fallback');
      expect(fallbackLine).toBeDefined();
      expect(fallbackLine.statusCode).toBe(503);
    });

    test('omits statusCode field when the error has none (client-side transient)', async () => {
      mockSend
        .mockRejectedValueOnce(new errors.RequestTimeoutError('client-side timeout'))
        .mockResolvedValueOnce(validReply);
      await callWithFallbacks('m1', ['m2'], { messages: [] });
      const fallbackLine = jsonLines()
        .map(l => JSON.parse(l))
        .find(p => p.event === 'fallback');
      expect(fallbackLine).toBeDefined();
      expect(fallbackLine).not.toHaveProperty('statusCode');
    });
  });
});

// ---
// Tests for askModelHandler exported from
// src/index.js — exercises the orchestration via injected mock dependencies.

// ---

describe('askModelHandler', () => {
  const allowedModels = new Set(['m1', 'm2', 'm3']);

  function makeDeps({ statImpl, readFileImpl, callImpl } = {}) {
    return {
      stat: statImpl ?? jest.fn(async () => ({ size: 100 })),
      readFile: readFileImpl ?? jest.fn(async () => Buffer.from('file body')),
      callWithFallbacks: callImpl ?? jest.fn(async () => validReply),
    };
  }

  // The deps shape the handler expects: `{ allowedModels, defaultSystemPrompt, deps: {...} }`.
  function ctx(deps = {}, overrides = {}) {
    return {
      allowedModels,
      defaultSystemPrompt: '',
      deps: makeDeps(deps),
      ...overrides,
    };
  }

  test('validation passthrough — invalid model returns isError', async () => {
    const c = ctx();
    const result = await askModelHandler(
      { model: 'bogus', message: 'hi', append_files: [''] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Model "bogus" is not allowed');
    // SDK never called
    expect(c.deps.callWithFallbacks).not.toHaveBeenCalled();
  });

  test('happy path — empty placeholder append_files, no system_prompt', async () => {
    const c = ctx();
    const result = await askModelHandler(
      { model: 'm1', message: 'hello', append_files: [''] },
      c
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('ok');
    expect(c.deps.callWithFallbacks).toHaveBeenCalledTimes(1);
    const [primary, fallbacks, requestParams] = c.deps.callWithFallbacks.mock.calls[0];
    expect(primary).toBe('m1');
    expect(fallbacks).toBeUndefined();
    expect(requestParams.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('happy path — system_prompt argument applied as system message', async () => {
    const c = ctx();
    await askModelHandler(
      { model: 'm1', message: 'hi', system_prompt: 'be terse', append_files: [''] },
      c
    );
    const [, , params] = c.deps.callWithFallbacks.mock.calls[0];
    expect(params.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('default system prompt applied when system_prompt arg missing', async () => {
    const c = ctx({}, { defaultSystemPrompt: 'always be polite' });
    await askModelHandler(
      { model: 'm1', message: 'hi', append_files: [''] },
      c
    );
    const [, , params] = c.deps.callWithFallbacks.mock.calls[0];
    expect(params.messages[0]).toEqual({ role: 'system', content: 'always be polite' });
  });

  test('arg system_prompt overrides default system prompt', async () => {
    const c = ctx({}, { defaultSystemPrompt: 'default sys' });
    await askModelHandler(
      { model: 'm1', message: 'hi', system_prompt: 'explicit sys', append_files: [''] },
      c
    );
    const [, , params] = c.deps.callWithFallbacks.mock.calls[0];
    expect(params.messages[0]).toEqual({ role: 'system', content: 'explicit sys' });
  });

  test('file processing — appends file body with separator', async () => {
    const c = ctx({
      statImpl: jest.fn(async () => ({ size: 50 })),
      readFileImpl: jest.fn(async () => Buffer.from('contents of file')),
    });
    await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['/path/file.txt'] },
      c
    );
    const [, , params] = c.deps.callWithFallbacks.mock.calls[0];
    expect(params.messages[0].content).toContain('hi');
    expect(params.messages[0].content).toContain('===== /path/file.txt =====');
    expect(params.messages[0].content).toContain('contents of file');
  });

  test('rejects when too many files', async () => {
    const c = ctx({}, { maxFiles: 2 });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['/a', '/b', '/c'] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Too many files: 3 exceeds maximum of 2');
  });

  test('rejects when file exceeds size limit', async () => {
    const c = ctx({
      statImpl: jest.fn(async () => ({ size: 200 * 1024 })),  // 200KB
    }, { maxFileSize: 150 * 1024 });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['/big'] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeds maximum size of 150KB');
  });

  test('rejects when file appears binary (contains NUL byte)', async () => {
    const c = ctx({
      statImpl: jest.fn(async () => ({ size: 50 })),
      readFileImpl: jest.fn(async () => Buffer.from([0x48, 0x00, 0x69])),  // H\0i
    });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['/binary'] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File appears to be binary');
  });

  test('wraps filesystem errors with file path context', async () => {
    const c = ctx({
      statImpl: jest.fn(async () => { throw new Error('ENOENT: no such file'); }),
    });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['/missing'] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to read file "/missing"');
    expect(result.content[0].text).toContain('ENOENT');
  });

  test('SDK errors propagate as user-facing error response', async () => {
    const c = ctx({
      callImpl: jest.fn(async () => { throw new Error('SDK boom'); }),
    });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: [''] },
      c
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error calling OpenRouter: SDK boom');
  });

  test('handles empty completion content with fallback message', async () => {
    const c = ctx({
      callImpl: jest.fn(async () => ({ choices: [{ message: { content: '' } }] })),
    });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: [''] },
      c
    );
    expect(result.content[0].text).toBe('No response received');
  });

  test('passes fallback_models through to callWithFallbacks', async () => {
    const c = ctx();
    await askModelHandler(
      { model: 'm1', message: 'hi', append_files: [''], fallback_models: ['m2', 'm3'] },
      c
    );
    const [primary, fallbacks] = c.deps.callWithFallbacks.mock.calls[0];
    expect(primary).toBe('m1');
    expect(fallbacks).toEqual(['m2', 'm3']);
  });

  test('files are filtered for empty string entries before counting', async () => {
    // append_files: ["", "/file"] → only /file processed, not the placeholder
    const c = ctx({}, { maxFiles: 1 });
    const result = await askModelHandler(
      { model: 'm1', message: 'hi', append_files: ['', '/file'] },
      c
    );
    // Should NOT exceed maxFiles=1 because "" is filtered out
    expect(result.isError).toBeUndefined();
    expect(c.deps.stat).toHaveBeenCalledTimes(1);
    expect(c.deps.stat).toHaveBeenCalledWith('/file');
  });
});
