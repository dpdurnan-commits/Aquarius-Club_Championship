import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { createAppContext, type AppContext } from './app-context.js';

/**
 * Feature: club-championship-scoring
 * API-level unit/integration tests for the Fastify REST endpoints (task 13.5).
 *
 * These are example-based (not property-based) tests. They exercise the wired
 * HTTP layer end to end — routes -> domain services -> repository — over an
 * isolated in-memory SQLite database, driving requests through Fastify's
 * `inject` so no real socket or on-disk file is touched. Each test asserts the
 * observable HTTP contract: validation-error responses (retain-and-message),
 * successful upserts, and the view snapshot shapes.
 *
 * Requirement coverage:
 *  - 1.5  Course endpoint rejects out-of-range par / stroke index, retains the
 *         stored value, and returns the permitted range in the message.
 *  - 2.6  Player/handicap endpoint rejects out-of-range handicap (non 0..36),
 *         retains the previously stored value, returns the 0..36 message.
 *  - 3.3  Day 1 complete endpoint rejects an invalid cut value, does not set
 *         Day_1_Complete, and returns the "must be a positive integer" message.
 *  - 7.4  Score endpoint rejects invalid gross, retains the prior cell value,
 *         and returns the 1..20 message.
 *  - 7.14 Score endpoint rejects a Day 2 submission for a CUT player, does not
 *         persist, and returns the "player is cut" message.
 *  - Plus successful upserts (course / player / score) and the Day 1 / Day 2
 *    view snapshot shapes.
 */

/** Build a fresh app over an isolated in-memory database for each test. */
async function buildApp(): Promise<{ app: FastifyInstance; context: AppContext }> {
  // ':memory:' gives each test its own ephemeral SQLite DB — the real on-disk
  // file is never touched. The context is the same object graph the server
  // entrypoint wires, so these tests exercise the production wiring.
  const context = createAppContext({ databaseFile: ':memory:' });
  const app = await createApp({ context });
  return { app, context };
}

describe('API endpoints (task 13.5)', () => {
  let app: FastifyInstance;
  let context: AppContext;

  beforeEach(async () => {
    ({ app, context } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // --- Course endpoint: validation + successful upsert (Requirements 1.5, 1.6) --

  describe('PUT /api/course/holes', () => {
    it('successfully upserts a hole par and stroke index (Requirement 1.6)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/course/holes',
        payload: { ordinal: 1, par: 4, strokeIndex: 7 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ordinal: 1, par: 4, strokeIndex: 7 });

      // The write is persisted: reading the holes reflects it.
      const holes = await app.inject({ method: 'GET', url: '/api/course/holes' });
      const hole1 = (holes.json() as Array<{ ordinal: number }>).find(
        (h) => h.ordinal === 1,
      );
      expect(hole1).toEqual({ ordinal: 1, par: 4, strokeIndex: 7 });
    });

    it('rejects an out-of-range par, retains the stored value, and returns the permitted range (Requirement 1.5)', async () => {
      // Establish a stored value first.
      await app.inject({
        method: 'PUT',
        url: '/api/course/holes',
        payload: { ordinal: 2, par: 4 },
      });

      // par = 7 is out of the 3..6 range.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/course/holes',
        payload: { ordinal: 2, par: 7 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; code?: string };
      expect(body.code).toBe('OUT_OF_RANGE');
      expect(body.error).toMatch(/3 to 6/);

      // The previously stored par is retained (no partial write).
      const hole2 = (
        (await app.inject({ method: 'GET', url: '/api/course/holes' })).json() as Array<{
          ordinal: number;
          par: number | null;
        }>
      ).find((h) => h.ordinal === 2);
      expect(hole2?.par).toBe(4);
    });

    it('rejects an out-of-range stroke index and returns the permitted range (Requirement 1.5)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/course/holes',
        payload: { ordinal: 3, strokeIndex: 19 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; code?: string };
      expect(body.code).toBe('OUT_OF_RANGE');
      expect(body.error).toMatch(/1 to 18/);
    });
  });

  // --- Player endpoint: validation + successful upsert (Requirements 2.1, 2.6) --

  describe('POST/PUT /api/players', () => {
    it('successfully adds a player (Requirement 2.1)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/players',
        payload: { name: 'Alice' },
      });

      expect(response.statusCode).toBe(200);
      const player = response.json() as { id: string; name: string; cut: boolean };
      expect(player.name).toBe('Alice');
      expect(player.cut).toBe(false);

      // The player is listed on a subsequent read.
      const players = (
        await app.inject({ method: 'GET', url: '/api/players' })
      ).json() as Array<{ name: string }>;
      expect(players.map((p) => p.name)).toContain('Alice');
    });

    it('successfully updates a player name and per-day handicaps (Requirement 2.5)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/players',
          payload: { name: 'Bob' },
        })
      ).json() as { id: string };

      const response = await app.inject({
        method: 'PUT',
        url: '/api/players',
        payload: { id: created.id, name: 'Bobby', handicapDay1: 12, handicapDay2: 10 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        name: 'Bobby',
        handicapDay1: 12,
        handicapDay2: 10,
      });
    });

    it('rejects an out-of-range handicap, retains the previously stored value, and returns the 0..36 message (Requirement 2.6)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/players',
          payload: { name: 'Carol' },
        })
      ).json() as { id: string };

      // Store a valid handicap first.
      await app.inject({
        method: 'PUT',
        url: '/api/players',
        payload: { id: created.id, name: 'Carol', handicapDay1: 15, handicapDay2: 15 },
      });

      // 40 is out of the 0..36 range.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/players',
        payload: { id: created.id, name: 'Carol', handicapDay1: 40, handicapDay2: 15 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; code?: string };
      expect(body.code).toBe('OUT_OF_RANGE');
      expect(body.error).toMatch(/0 to 36/);

      // The previously stored handicap is retained (rejected write is a no-op).
      const players = (
        await app.inject({ method: 'GET', url: '/api/players' })
      ).json() as Array<{ id: string; handicapDay1: number | null }>;
      const carol = players.find((p) => p.id === created.id);
      expect(carol?.handicapDay1).toBe(15);
    });
  });

  // --- Day 1 completion endpoint: cut-value validation (Requirement 3.3) --------

  describe('POST /api/day1/complete', () => {
    it('rejects an invalid cut value, does not set Day_1_Complete, and returns the positive-integer message (Requirement 3.3)', async () => {
      for (const cutValue of [0, -3, 2.5, 'abc', null]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/day1/complete',
          payload: { cutValue },
        });

        expect(response.statusCode).toBe(400);
        const body = response.json() as { error: string; code?: string };
        expect(body.code).toBe('INVALID');
        expect(body.error).toMatch(/positive integer/i);
      }

      // Day_1_Complete was never set on any rejected attempt.
      expect(context.repository.getCompetitionState()).toEqual({
        day1Complete: false,
        cutValue: null,
      });
    });

    it('marks Day 1 complete for a valid positive-integer cut value (Requirement 3.2)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/day1/complete',
        payload: { cutValue: 10 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ day1Complete: true, cutValue: 10 });
    });
  });

  // --- Score endpoint: validation + CUT gate + upsert (Requirements 7.4, 7.14) --

  describe('POST /api/scores', () => {
    let playerId: string;

    beforeEach(async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/players',
          payload: { name: 'Dave' },
        })
      ).json() as { id: string };
      playerId = created.id;
    });

    it('successfully upserts a numeric score (Requirement 7.5)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId, day: 1, ordinal: 1, value: 4 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        playerId,
        day: 1,
        ordinal: 1,
        state: { kind: 'numeric', gross: 4 },
      });
    });

    it('successfully upserts an NR score (Requirement 7.11)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId, day: 1, ordinal: 2, value: 'NR' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        playerId,
        day: 1,
        ordinal: 2,
        state: { kind: 'NR' },
      });
    });

    it('rejects an out-of-range gross, retains the prior cell value, and returns the 1..20 message (Requirement 7.4)', async () => {
      // Store a valid gross first.
      await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId, day: 1, ordinal: 3, value: 5 },
      });

      // 25 is out of the 1..20 range.
      const response = await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId, day: 1, ordinal: 3, value: 25 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; code?: string };
      expect(body.code).toBe('OUT_OF_RANGE');
      expect(body.error).toMatch(/1 to 20/);

      // The prior cell value is retained (rejected write is a no-op).
      expect(context.repository.getCellState(playerId, 1, 3)).toEqual({
        kind: 'numeric',
        gross: 5,
      });
    });

    it('rejects a Day 2 submission for a CUT player, does not persist, and returns "player is cut" (Requirement 7.14)', async () => {
      // Mark the player CUT directly on the repository (the state Day 1
      // completion would produce), then attempt a Day 2 entry.
      context.repository.setPlayerCut(playerId, true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId, day: 2, ordinal: 1, value: 4 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; code?: string };
      expect(body.code).toBe('PLAYER_CUT');
      expect(body.error).toMatch(/cut/i);

      // No Day 2 cell was persisted.
      expect(context.repository.getCellState(playerId, 2, 1)).toEqual({
        kind: 'unrecorded',
      });
    });
  });

  // --- View endpoints: snapshot shapes (Requirements 8.1, 9.1) ------------------

  describe('GET /api/view/day1 and /api/view/day2', () => {
    it('returns the Day 1 view snapshot shape with an 18-column header (Requirement 8.1)', async () => {
      // Configure the course + a player + a score so the snapshot has content.
      await app.inject({
        method: 'PUT',
        url: '/api/course/holes',
        payload: { ordinal: 1, par: 4, strokeIndex: 1 },
      });
      const player = (
        await app.inject({
          method: 'POST',
          url: '/api/players',
          payload: { name: 'Eve' },
        })
      ).json() as { id: string };
      await app.inject({
        method: 'PUT',
        url: '/api/players',
        payload: { id: player.id, name: 'Eve', handicapDay1: 10, handicapDay2: 10 },
      });
      await app.inject({
        method: 'POST',
        url: '/api/scores',
        payload: { playerId: player.id, day: 1, ordinal: 1, value: 4 },
      });

      const response = await app.inject({ method: 'GET', url: '/api/view/day1' });
      expect(response.statusCode).toBe(200);

      const view = response.json() as {
        day: number;
        header: Array<{ ordinal: number }>;
        rows: Array<{
          playerId: string;
          name: string;
          holes: unknown[];
          aggregateStrokes: { text: string };
          aggregateStableford: { text: string };
          relativeToPar: { text: string };
        }>;
      };

      expect(view.day).toBe(1);
      expect(view.header).toHaveLength(18);
      expect(view.header.map((h) => h.ordinal)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      ]);

      const eveRow = view.rows.find((r) => r.playerId === player.id);
      expect(eveRow).toBeDefined();
      expect(eveRow?.name).toBe('Eve');
      expect(eveRow?.holes).toHaveLength(18);
      expect(eveRow?.aggregateStrokes).toHaveProperty('text');
      expect(eveRow?.aggregateStableford).toHaveProperty('text');
      expect(eveRow?.relativeToPar).toHaveProperty('text');
    });

    it('returns the Day 2 view snapshot shape with an 18-column header (Requirement 9.1)', async () => {
      const player = (
        await app.inject({
          method: 'POST',
          url: '/api/players',
          payload: { name: 'Frank' },
        })
      ).json() as { id: string };

      const response = await app.inject({ method: 'GET', url: '/api/view/day2' });
      expect(response.statusCode).toBe(200);

      const view = response.json() as {
        day: number;
        header: Array<{ ordinal: number }>;
        rows: Array<{ playerId: string; name: string; cut: boolean; holes: unknown[] }>;
      };

      expect(view.day).toBe(2);
      expect(view.header).toHaveLength(18);

      const frankRow = view.rows.find((r) => r.playerId === player.id);
      expect(frankRow).toBeDefined();
      expect(frankRow?.name).toBe('Frank');
      expect(frankRow?.cut).toBe(false);
      expect(frankRow?.holes).toHaveLength(18);
    });
  });
});
