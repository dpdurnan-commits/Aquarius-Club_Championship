import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from './client.js';

/** Build a fetch stub returning a JSON response with the given status/body. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('ApiClient', () => {
  it('returns ok with the parsed value on a 2xx response', async () => {
    const players = [
      { id: 'p1', name: 'Ann', handicapDay1: 10, handicapDay2: null, cut: false },
    ];
    const client = new ApiClient({ fetchImpl: jsonFetch(200, players) });

    const result = await client.getPlayers();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(players);
    }
  });

  it('maps a rejected response to an error result with message and code', async () => {
    const client = new ApiClient({
      fetchImpl: jsonFetch(400, {
        error: 'Par must be a whole number from 3 to 6.',
        code: 'OUT_OF_RANGE',
      }),
    });

    const result = await client.putHole({ ordinal: 1, par: 9 as unknown as 6 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/whole number from 3 to 6/i);
      expect(result.code).toBe('OUT_OF_RANGE');
    }
  });

  it('resolves an empty 200 body to ok(undefined) for void endpoints', async () => {
    const client = new ApiClient({ fetchImpl: jsonFetch(200, undefined) });

    const result = await client.completeDay1(20);

    expect(result.ok).toBe(true);
  });

  it('maps a transport failure to a PERSISTENCE_FAILED error', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = new ApiClient({ fetchImpl: failingFetch });

    const result = await client.getDay1View();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
    }
  });

  it('sends requests against the configured base url', async () => {
    const spy = vi.fn(async () => new Response('[]', { status: 200 }));
    const client = new ApiClient({
      baseUrl: '/api',
      fetchImpl: spy as unknown as typeof fetch,
    });

    await client.getHoles();

    expect(spy).toHaveBeenCalledWith('/api/course/holes', expect.anything());
    expect(client.eventsUrl()).toBe('/api/events');
  });
});
