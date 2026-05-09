import { describe, expect, test } from '@jest/globals';

describe('test infrastructure', () => {
  test('Jest runs under ESM with @jest/globals import', () => {
    expect(true).toBe(true);
  });

  test('async/await works in test bodies', async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });
});
