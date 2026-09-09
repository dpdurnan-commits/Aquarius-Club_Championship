import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { createAppContext, type AppContext } from './app-context.js';

/**
 * Feature: club-championship-scoring
 * End-to-end integration test — full competition flow (task 19.2).
 *
 * This is an example-based INTEGRATION test (not a property test). It drives the
 * fully-wired stack — the Fastify routes, the domain services (course/competition
 * setup, score entry, ranking + cut), the repository over an isolated in-memory
 * SQLite database, and the display assembler — through Fastify's `inject`, and
 * walks a single realistic tournament from an empty database to rendered Day 1
 * and Day 2 views. Per the design's Testing Strategy the correctness of each
 * individual rule is covered by the per-module property tests; this test proves
 * the pieces compose correctly across the whole flow.
 *
 * The scenario configures a par-72 course (18 holes, par 4, ascending stroke
 * index) and four scratch (handicap 0) players so net strokes equal gross and
 * every ranking outcome is deterministic:
 *
 *  - Alice — every hole gross 4  → gross 72, Stableford 36.
 *  - Bob   — every hole gross 4  → gross 72, Stableford 36  (a TIE with Alice).
 *  - Carol — every hole gross 5  → gross 90, Stableford 18.
 *  - Dave  — hole 1 NR, rest 4   → No_Return on Day 1 (unranked in both).
 *
 * With a cut value X = 2:
 *  - Scratch (gross asc):    Alice & Bob tie at position 1; Carol at position 3;
 *    Dave unranked (NR).
 *  - Stableford (points desc): Alice & Bob tie at position 1; Carol at position 3;
 *    Dave unranked (NR).
 *  - Cut evaluation: Alice and Bob advance (position 1 ≤ 2 in both); Carol is CUT
 *    (position 3 > 2 in both); Dave is CUT (Day 1 No_Return).
 *
 * The test then attempts a blocked Day 2 score entry for the cut player Carol and
 * confirms it is rejected, and asserts the Day 1 and Day 2 view snapshots render
 * correctly (18-column headers, per-hole cells, aggregates, positions, signed
 * relative-to-par, and CUT/NR handling).
 *
 * Requirement coverage:
 *  - 3.4  Marking Day 1 complete evaluates CUT for every player.
 *  - 6.4  Positions recompute (here observed on the marked-complete snapshot,
 *         asserted within the 5s budget).
 *  - 7.14 A cut player is blocked from receiving a Day 2 score.
 *  - 8.1  The Day 1 view header lists holes 1..18.
 *  - 9.1  The Day 2 view header lists holes 1..18.
 *  - 9.17 CUT is shown against the player name on Day 2.
 */

/** Budget for the Day-1-complete recompute to be observable. (Requirement 6.4) */
const RECOMPUTE_BUDGET_MS = 5_000;

/** The cut value X used in this scenario. */
const CUT_VALUE = 2;

/** All 18 hole ordinals, ascending. */
const ORDINALS = Array.from({ length: 18 }, (_, i) => i + 1);

/** Build a fresh app over an isolated in-memory database for each test. */
async function buildApp(): Promise<{ app: FastifyInstance; context: AppContext }> {
  const context = createAppContext({ databaseFile: ':memory:' });
  const app = await createApp({ context });
  return { app, context };
}

describe('End-to-end integration: full competition flow (task 19.2)', () => {
  let app: FastifyInstance;
  let context: AppContext;

  beforeEach(async () => {
    ({ app, context } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  /** POST/PUT/GET a JSON body through Fastify's in-process `inject`. */
  async function api<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: T }> {
    const response = await app.inject({ method, url, payload });
    const text = response.body;
    return {
      statusCode: response.statusCode,
      body: (text === '' ? undefined : response.json()) as T,
    };
  }

  /** Configure all 18 holes as par 4 with an ascending (1..18) stroke index. */
  async function configureCourse(): Promise<void> {
    for (const ordinal of ORDINALS) {
      const res = await api('PUT', '/api/course/holes', {
        ordinal,
        par: 4,
        strokeIndex: ordinal,
      });
      expect(res.statusCode).toBe(200);
    }
  }

  /** Add a scratch (handicap 0) player and return the assigned id. */
  async function addScratchPlayer(name: string): Promise<string> {
    const created = await api<{ id: string }>('POST', '/api/players', { name });
    expect(created.statusCode).toBe(200);
    const updated = await api('PUT', '/api/players', {
      id: created.body.id,
      name,
      handicapDay1: 0,
      handicapDay2: 0,
    });
    expect(updated.statusCode).toBe(200);
    return created.body.id;
  }

  /** Submit a numeric gross for a single cell, asserting success. */
  async function submitGross(
    playerId: string,
    day: 1 | 2,
    ordinal: number,
    value: number,
  ): Promise<void> {
    const res = await api('POST', '/api/scores', { playerId, day, ordinal, value });
    expect(res.statusCode).toBe(200);
  }

  /** Submit an NR for a single cell, asserting success. */
  async function submitNR(
    playerId: string,
    day: 1 | 2,
    ordinal: number,
  ): Promise<void> {
    const res = await api('POST', '/api/scores', {
      playerId,
      day,
      ordinal,
      value: 'NR',
    });
    expect(res.statusCode).toBe(200);
  }

  // --- Day 1 view row shape read back from the snapshot. ------------------------
  interface Day1Row {
    readonly playerId: string;
    readonly name: string;
    readonly holes: ReadonlyArray<{ kind: string; gross?: number; points?: number; text: string }>;
    readonly aggregateStrokes: { text: string; total: number; position: number | null; isNR: boolean };
    readonly aggregateStableford: { text: string; total: number; position: number | null; isNR: boolean };
    readonly relativeToPar: { text: string; value: number | null; isNR: boolean };
  }
  interface Day1ViewBody {
    readonly day: number;
    readonly header: ReadonlyArray<{ ordinal: number; par: number | null; strokeIndex: number | null }>;
    readonly rows: readonly Day1Row[];
  }

  // --- Day 2 view row shape read back from the snapshot. ------------------------
  interface Day2Row {
    readonly playerId: string;
    readonly name: string;
    readonly cut: boolean;
    readonly day1AggregateStrokes: number | null;
    readonly holes: ReadonlyArray<{ kind: string; text: string }>;
    readonly combinedStrokes: { text: string } | null;
    readonly combinedStableford: { text: string; total36: number } | null;
    readonly relativeToPar: { text: string; isNR: boolean };
  }
  interface Day2ViewBody {
    readonly day: number;
    readonly header: ReadonlyArray<{ ordinal: number }>;
    readonly rows: readonly Day2Row[];
  }

  it('runs setup → Day 1 scoring (NR + tie) → cut evaluation → blocked Day 2 entry → correct Day 1/Day 2 views', async () => {
    // --- 1. Configure the course and the four players ------------------------
    await configureCourse();
    const alice = await addScratchPlayer('Alice');
    const bob = await addScratchPlayer('Bob');
    const carol = await addScratchPlayer('Carol');
    const dave = await addScratchPlayer('Dave');

    // --- 2. Enter Day 1 scores (includes an NR and a tie) --------------------
    // Alice and Bob: gross 4 on every hole → tie at 72 gross / 36 Stableford.
    for (const ordinal of ORDINALS) {
      await submitGross(alice, 1, ordinal, 4);
      await submitGross(bob, 1, ordinal, 4);
    }
    // Carol: gross 5 on every hole → 90 gross / 18 Stableford (well outside top 2).
    for (const ordinal of ORDINALS) {
      await submitGross(carol, 1, ordinal, 5);
    }
    // Dave: hole 1 is NR, the rest gross 4 → Day 1 No_Return (unranked → cut).
    await submitNR(dave, 1, 1);
    for (const ordinal of ORDINALS.slice(1)) {
      await submitGross(dave, 1, ordinal, 4);
    }

    // --- 3. Mark Day 1 complete with the cut value, measuring recompute ------
    const markStart = Date.now();
    const marked = await api<{ day1Complete: boolean; cutValue: number }>(
      'POST',
      '/api/day1/complete',
      { cutValue: CUT_VALUE },
    );
    expect(marked.statusCode).toBe(200);
    expect(marked.body).toEqual({ day1Complete: true, cutValue: CUT_VALUE });

    // --- 4. Verify advance/cut decisions are correct (Requirement 3.4) -------
    // The service evaluated and persisted a CUT flag for every player.
    const players = context.repository.getPlayers();
    const cutById = new Map(players.map((p) => [p.id, p.cut]));
    expect(cutById.get(alice)).toBe(false); // tie at position 1 → advances
    expect(cutById.get(bob)).toBe(false); // tie at position 1 → advances
    expect(cutById.get(carol)).toBe(true); // position 3 > 2 in both → cut
    expect(cutById.get(dave)).toBe(true); // Day 1 NR → cut

    // The recompute is observable within the 5s budget (Requirement 6.4): the
    // Day 1 snapshot read after completion carries recomputed positions.
    const day1AfterComplete = await api<Day1ViewBody>('GET', '/api/view/day1');
    const recomputeLatency = Date.now() - markStart;
    expect(day1AfterComplete.statusCode).toBe(200);
    expect(recomputeLatency).toBeLessThan(RECOMPUTE_BUDGET_MS);

    // --- 5. A blocked Day 2 entry for a cut player is rejected (7.14) --------
    const blocked = await api<{ error: string; code?: string }>('POST', '/api/scores', {
      playerId: carol,
      day: 2,
      ordinal: 1,
      value: 4,
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body.code).toBe('PLAYER_CUT');
    expect(blocked.body.error).toMatch(/cut/i);
    // No Day 2 cell was persisted for the cut player.
    expect(context.repository.getCellState(carol, 2, 1)).toEqual({ kind: 'unrecorded' });

    // A non-cut player can still enter a Day 2 score (proves the gate is
    // specific to cut players, not a blanket Day 2 lock).
    await submitGross(alice, 2, 1, 3);

    // --- 6a. Day 1 view renders correctly (Requirements 8.1, plus cells) -----
    const day1 = day1AfterComplete;
    // Header lists holes 1..18 in ascending order. (8.1)
    expect(day1.body.day).toBe(1);
    expect(day1.body.header.map((h) => h.ordinal)).toEqual(ORDINALS);
    expect(day1.body.header.every((h) => h.par === 4)).toBe(true);

    const d1 = (id: string): Day1Row => {
      const row = day1.body.rows.find((r) => r.playerId === id);
      expect(row).toBeDefined();
      return row!;
    };

    // Alice: 18 per-hole "4 (2)" cells, gross total 72, Stableford 36,
    // relative-to-par exactly even ("0"), and a shared position 1 (the tie). (8.3–8.9)
    const aliceRow = d1(alice);
    expect(aliceRow.holes).toHaveLength(18);
    expect(aliceRow.holes.every((c) => c.kind === 'numeric' && c.text === '4 (2)')).toBe(true);
    expect(aliceRow.aggregateStrokes.total).toBe(72);
    expect(aliceRow.aggregateStableford.total).toBe(36);
    expect(aliceRow.relativeToPar.text).toBe('0');
    expect(aliceRow.aggregateStrokes.position).toBe(1);
    expect(aliceRow.aggregateStableford.position).toBe(1);

    // Bob ties Alice: identical totals and the same shared position 1. (6.1, 6.2)
    const bobRow = d1(bob);
    expect(bobRow.aggregateStrokes.total).toBe(72);
    expect(bobRow.aggregateStrokes.position).toBe(1);
    expect(bobRow.aggregateStableford.position).toBe(1);

    // Carol: gross 90, Stableford 18, ranked at position 3 (the tie skips 2). (6.1)
    const carolRow = d1(carol);
    expect(carolRow.aggregateStrokes.total).toBe(90);
    expect(carolRow.aggregateStableford.total).toBe(18);
    expect(carolRow.aggregateStrokes.position).toBe(3);
    expect(carolRow.aggregateStableford.position).toBe(3);
    expect(carolRow.relativeToPar.text).toBe('+18');

    // Dave (NR on Day 1): the NR hole renders "NR", the aggregate/position show
    // the NR treatment (unranked → null position, "NR" text). (8.11–8.14)
    const daveRow = d1(dave);
    expect(daveRow.holes[0]).toMatchObject({ kind: 'NR', text: 'NR' });
    expect(daveRow.aggregateStrokes.isNR).toBe(true);
    expect(daveRow.aggregateStrokes.position).toBeNull();
    expect(daveRow.aggregateStableford.position).toBeNull();
    expect(daveRow.relativeToPar.isNR).toBe(true);

    // --- 6b. Day 2 view renders correctly (Requirements 9.1, 9.17) -----------
    const day2 = await api<Day2ViewBody>('GET', '/api/view/day2');
    expect(day2.statusCode).toBe(200);
    // Header lists holes 1..18. (9.1)
    expect(day2.body.day).toBe(2);
    expect(day2.body.header.map((h) => h.ordinal)).toEqual(ORDINALS);

    const d2 = (id: string): Day2Row => {
      const row = day2.body.rows.find((r) => r.playerId === id);
      expect(row).toBeDefined();
      return row!;
    };

    // Cut players show CUT and have their Day 2 scores/aggregates suppressed. (9.17, 9.18)
    const carolD2 = d2(carol);
    expect(carolD2.cut).toBe(true);
    expect(carolD2.combinedStrokes).toBeNull();
    expect(carolD2.combinedStableford).toBeNull();
    expect(carolD2.holes.every((c) => c.kind === 'empty')).toBe(true);

    const daveD2 = d2(dave);
    expect(daveD2.cut).toBe(true);

    // Non-cut players are not marked CUT and carry their Day 1 aggregate column. (9.5)
    const aliceD2 = d2(alice);
    expect(aliceD2.cut).toBe(false);
    expect(aliceD2.day1AggregateStrokes).toBe(72);
    // Alice's single Day 2 hole (gross 3, par 4 → net -1 → 3 pts) is rendered. (9.6)
    expect(aliceD2.holes[0]).toMatchObject({ kind: 'numeric', text: '3 (3)' });
    expect(aliceD2.combinedStrokes).not.toBeNull();
    expect(aliceD2.combinedStableford).not.toBeNull();

    const bobD2 = d2(bob);
    expect(bobD2.cut).toBe(false);

    // Day 2 ordering: non-CUT players (Alice, Bob) come before the CUT block
    // (Carol, Dave). (9.3, 9.4)
    const orderedIds = day2.body.rows.map((r) => r.playerId);
    const lastNonCutIndex = Math.max(orderedIds.indexOf(alice), orderedIds.indexOf(bob));
    const firstCutIndex = Math.min(orderedIds.indexOf(carol), orderedIds.indexOf(dave));
    expect(lastNonCutIndex).toBeLessThan(firstCutIndex);
  }, 20_000);
});
