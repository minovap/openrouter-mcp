// Unit tests for callWithFallbacks — chain semantics + isTransientSdkError
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
const { callWithFallbacks } = await import('../src/index.js');

const validReply = { id: 'r1', choices: [{ message: { content: 'ok' } }] };

// SDK error fixtures.
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
    // Client-side transients
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

    // Server-side typed transients
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

    // Untyped 5xx via OpenRouterDefaultError + statusCode
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

    // 504 Gateway Timeout — there is NO typed GatewayTimeoutResponseError
    // in @openrouter/sdk/models/errors (only 408/502/503/524/529 typed); a 504
    // surfaces as OpenRouterDefaultError with statusCode=504, covered by the same
    // `statusCode >= 500` branch as the 522 case.
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

  describe('fail-fast on terminal errors (programmer-error policy)', () => {
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
      // Three rejections, two fallbacks — all three attempts made; last error propagates.
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
      // ts is an ISO timestamp string
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
