import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { createAppContext, type AppContext } from './app-context.js';

/**
 * Feature: club-championship-scoring
 * Integration test — recompute + SSE push within budget (task 13.6).
 *
 * This is an example-based INTEGRATION test (not a property test). Timing and
 * real-time transport behavior does not vary meaningfully with input, so per the
 * design's Testing Strategy it is covered by a representative integration example
 * rather than a property. It exercises the fully-wired stack over a REAL HTTP
 * socket — a listening Fastify server, the in-process broker, the SSE endpoint,
 * the score entry service, the repository, and the display assembler — driving a
 * live `EventSource`-style stream with Node's raw `http` client so the actual
 * network path and wall-clock latencies are measured (Fastify's `inject` cannot
 * hold an open streaming SSE response).
 *
 * The scenario: two players with distinct Day 1 handicaps/scores are configured
 * so their scratch positions differ. A display opens the SSE stream, then a Day 1
 * score is POSTed for a player. The test asserts:
 *  - the score-entry confirmation returns within 3 seconds (Requirement 7.7);
 *  - a `score-changed` event is pushed over the already-open SSE stream within 5
 *    seconds, with NO reload / re-request of the stream (Requirements 10.1,
 *    10.3);
 *  - re-reading the recomputed view snapshot within the 5s budget reflects the
 *    updated player's row/aggregates and recomputed Competition_Position for
 *    every player (Requirements 6.4, 10.1, 10.2).
 *
 * Requirement coverage:
 *  - 6.4  Persisting a Day 1 score recomputes each player's Competition_Position
 *         within 5 seconds.
 *  - 7.7  Score submission confirmation is returned within 3 seconds.
 *  - 10.1 The persisted gross strokes update the affected player row within 5s.
 *  - 10.2 The persisted gross strokes recompute and update the aggregate
 *         strokes / Stableford / relative-to-par / position cells within 5s.
 *  - 10.3 The display updates without a manual page reload — the update arrives
 *         on the pre-existing SSE stream, no new stream request is made.
 */

/** Budget for a score-entry confirmation to come back. (Requirement 7.7) */
const CONFIRMATION_BUDGET_MS = 3_000;
/** Budget for the recompute/push to reach the display. (Requirements 6.4, 10.1–10.3) */
const UPDATE_BUDGET_MS = 5_000;

/** A minimal JSON HTTP response captured from the raw client. */
interface JsonResponse<T> {
  readonly statusCode: number;
  readonly body: T;
}

/**
 * A live SSE stream reader over a real socket. Frames are parsed as they arrive
 * so a test can await the next `event:`/`data:` block without re-requesting the
 * stream — mirroring the browser `EventSource` the display uses.
 */
interface SseStream {
  /** The underlying request, used to close the connection on teardown. */
  readonly request: http.ClientRequest;
  /**
   * Resolve when a frame whose `event:` type equals `type` arrives, returning the
   * parsed `data:` JSON. Rejects if the budget elapses first. Matches frames that
   * arrive after the call as well as any already buffered.
   */
  waitForEvent(type: string, timeoutMs: number): Promise<Record<string, unknown>>;
  /** Number of times the stream endpoint was opened (used to prove no reload). */
  readonly openCount: () => number;
  /** Close the stream. */
  close(): void;
}

describe('Integration: recompute + SSE push within budget (task 13.6)', () => {
  let app: FastifyInstance;
  let context: AppContext;
  let baseUrl: string;
  /** Count of SSE stream opens observed by the client, to prove no reload. */
  let sseOpenCount = 0;
  /** Live SSE streams opened during a test, torn down before the server closes. */
  let openStreams: SseStream[] = [];

  beforeEach(async () => {
    // ':memory:' isolates each test on its own ephemeral SQLite DB. A real
    // listening socket (port 0 → OS-assigned free port) is required so the SSE
    // stream can stay open across the score submission.
    context = createAppContext({ databaseFile: ':memory:' });
    app = await createApp({ context });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    sseOpenCount = 0;
    openStreams = [];
  });

  afterEach(async () => {
    // Destroy every open SSE socket first: an in-flight `text/event-stream`
    // response holds the connection open, so `app.close()` would otherwise block
    // waiting for it to drain.
    for (const stream of openStreams) {
      stream.close();
    }
    openStreams = [];
    await app.close();
    context.close();
  });

  /** Perform a JSON request/response over the real socket. */
  function jsonRequest<T>(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<JsonResponse<T>> {
    return new Promise((resolve, reject) => {
      const data = payload === undefined ? undefined : JSON.stringify(payload);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers:
            data === undefined
              ? { accept: 'application/json' }
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(data),
                },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              statusCode: res.statusCode ?? 0,
              body: (text === '' ? undefined : JSON.parse(text)) as T,
            });
          });
        },
      );
      req.on('error', reject);
      if (data !== undefined) {
        req.write(data);
      }
      req.end();
    });
  }

  /**
   * Open a live SSE stream to `/api/events` and return a reader that resolves the
   * next event of a requested type. The stream is opened exactly once; the reader
   * consumes the persistent response body incrementally.
   */
  async function openSse(): Promise<SseStream> {
    const req = http.request(`${baseUrl}/api/events`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });

    let buffer = '';
    /** Frames parsed but not yet consumed by a waiter. */
    const pending: Array<{ type: string; data: Record<string, unknown> }> = [];
    /** Resolvers waiting for a matching frame. */
    const waiters: Array<{
      type: string;
      resolve: (data: Record<string, unknown>) => void;
    }> = [];

    const dispatch = (type: string, data: Record<string, unknown>): void => {
      const idx = waiters.findIndex((w) => w.type === type);
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        waiter!.resolve(data);
      } else {
        pending.push({ type, data });
      }
    };

    req.on('response', (res) => {
      sseOpenCount += 1;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventType: string | undefined;
          let dataLine: string | undefined;
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
              dataLine = line.slice('data:'.length).trim();
            }
          }
          if (eventType !== undefined && dataLine !== undefined) {
            dispatch(eventType, JSON.parse(dataLine) as Record<string, unknown>);
          }
        }
      });
    });

    req.end();
    // Wait for the response headers so the subscription is attached before the
    // caller triggers an event (otherwise a fast push could race the connect).
    await once(req, 'response');

    const stream: SseStream = {
      request: req,
      openCount: () => sseOpenCount,
      waitForEvent(type: string, timeoutMs: number): Promise<Record<string, unknown>> {
        const already = pending.findIndex((p) => p.type === type);
        if (already >= 0) {
          const [frame] = pending.splice(already, 1);
          return Promise.resolve(frame!.data);
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === wrapped);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`No "${type}" SSE event within ${timeoutMs}ms`));
          }, timeoutMs);
          const wrapped = (data: Record<string, unknown>): void => {
            clearTimeout(timer);
            resolve(data);
          };
          waiters.push({ type, resolve: wrapped });
        });
      },
      close(): void {
        req.destroy();
      },
    };
    openStreams.push(stream);
    return stream;
  }

  /**
   * Configure a fully-playable course (18 holes, par 4, ascending stroke index)
   * and two players with distinct Day 1 handicaps so their scratch positions can
   * differ once scores are entered.
   */
  async function seedCourseAndPlayers(): Promise<{ alice: string; bob: string }> {
    for (let ordinal = 1; ordinal <= 18; ordinal += 1) {
      await jsonRequest('PUT', '/api/course/holes', {
        ordinal,
        par: 4,
        strokeIndex: ordinal,
      });
    }

    const alice = (
      await jsonRequest<{ id: string }>('POST', '/api/players', { name: 'Alice' })
    ).body.id;
    const bob = (
      await jsonRequest<{ id: string }>('POST', '/api/players', { name: 'Bob' })
    ).body.id;

    await jsonRequest('PUT', '/api/players', {
      id: alice,
      name: 'Alice',
      handicapDay1: 10,
      handicapDay2: 10,
    });
    await jsonRequest('PUT', '/api/players', {
      id: bob,
      name: 'Bob',
      handicapDay1: 10,
      handicapDay2: 10,
    });

    return { alice, bob };
  }

  /** The Day 1 view row shape this test reads back. */
  interface Day1Row {
    readonly playerId: string;
    readonly holes: ReadonlyArray<{ kind: string; gross?: number; text: string }>;
    readonly aggregateStrokes: { text: string; total: number; position: number | null };
  }

  it('confirms a Day 1 score within 3s, pushes the change over the open SSE stream within 5s, and recomputes positions/aggregates without a reload (Requirements 6.4, 7.7, 10.1, 10.2, 10.3)', async () => {
    const { alice, bob } = await seedCourseAndPlayers();

    // Seed a baseline so both players already have an aggregate/position before
    // the measured submission. Alice starts ahead of Bob on hole 1.
    await jsonRequest('POST', '/api/scores', {
      playerId: alice,
      day: 1,
      ordinal: 1,
      value: 4,
    });
    await jsonRequest('POST', '/api/scores', {
      playerId: bob,
      day: 1,
      ordinal: 1,
      value: 6,
    });

    // Open the live display stream BEFORE the measured submission. It stays open
    // for the whole scenario — the update must arrive on this stream with no
    // reload. (Requirement 10.3)
    const sse = await openSse();
    try {
      expect(sse.openCount()).toBe(1);

      // --- Submit a Day 1 score and assert the confirmation is within 3s (7.7) --
      const submitStart = Date.now();
      const confirmation = await jsonRequest<{
        playerId: string;
        day: number;
        ordinal: number;
        state: { kind: string; gross?: number };
      }>('POST', '/api/scores', { playerId: bob, day: 1, ordinal: 2, value: 3 });
      const confirmationLatency = Date.now() - submitStart;

      expect(confirmation.statusCode).toBe(200);
      expect(confirmation.body).toMatchObject({
        playerId: bob,
        day: 1,
        ordinal: 2,
        state: { kind: 'numeric', gross: 3 },
      });
      expect(confirmationLatency).toBeLessThan(CONFIRMATION_BUDGET_MS);

      // --- Assert the change is pushed over the SSE stream within 5s (10.1, 10.3)
      const pushStart = Date.now();
      const pushed = await sse.waitForEvent('score-changed', UPDATE_BUDGET_MS);
      const pushLatency = Date.now() - pushStart;

      expect(pushed).toMatchObject({
        type: 'score-changed',
        playerId: bob,
        day: 1,
        ordinal: 2,
      });
      expect(pushLatency).toBeLessThan(UPDATE_BUDGET_MS);

      // The update arrived on the SAME stream opened earlier — no reload / new
      // stream request was made. (Requirement 10.3)
      expect(sse.openCount()).toBe(1);

      // --- Read the recomputed snapshot within budget (6.4, 10.1, 10.2) --------
      const viewStart = Date.now();
      const view = await jsonRequest<{ rows: Day1Row[] }>('GET', '/api/view/day1');
      const viewLatency = Date.now() - viewStart;
      const totalRecomputeLatency = Date.now() - submitStart;

      expect(view.statusCode).toBe(200);
      expect(viewLatency).toBeLessThan(UPDATE_BUDGET_MS);
      // The whole submit → recompute → observable-update cycle is within 5s.
      expect(totalRecomputeLatency).toBeLessThan(UPDATE_BUDGET_MS);

      const bobRow = view.body.rows.find((r) => r.playerId === bob);
      const aliceRow = view.body.rows.find((r) => r.playerId === alice);
      expect(bobRow).toBeDefined();
      expect(aliceRow).toBeDefined();

      // The affected player's row reflects the newly persisted cell. (10.1)
      expect(bobRow!.holes[1]).toMatchObject({ kind: 'numeric', gross: 3 });

      // The aggregate strokes recomputed to include the new hole: Bob now has
      // 6 + 3 = 9 gross across two holes. (10.2)
      expect(bobRow!.aggregateStrokes.total).toBe(9);
      // Alice's baseline aggregate (single hole, gross 4) is unchanged. (10.2)
      expect(aliceRow!.aggregateStrokes.total).toBe(4);

      // Competition_Position recomputed for BOTH players against the new totals.
      // Same Day 1 handicap (10) → net strokes = gross; Alice (net 4) ranks ahead
      // of Bob (net 9), so Alice is position 1 and Bob position 2. (6.4, 10.2)
      expect(aliceRow!.aggregateStrokes.position).toBe(1);
      expect(bobRow!.aggregateStrokes.position).toBe(2);
    } finally {
      sse.close();
    }
  }, 20_000);
});
