import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DAYS,
  GROSS_MAX,
  GROSS_MIN,
  HANDICAP_MAX,
  HANDICAP_MIN,
  HOLE_ORDINALS,
  NO_RETURN,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
  STROKE_INDEX_MAX,
  STROKE_INDEX_MIN,
  numericCell,
  type CellState,
  type Day,
  type Gross,
  type HoleOrdinal,
  type Par,
  type PlayingHandicap,
  type StrokeIndex,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';

/**
 * Feature: club-championship-scoring
 * Property 4: Configuration persistence round-trip
 *
 * Validates: Requirements 1.6, 1.7, 2.8, 2.9
 *
 * For any valid par, stroke index, player name, or per-day handicap that is
 * saved or updated, reading it back afterward yields the value that was
 * written. This exercises the Repository persistence layer (SQLite via
 * better-sqlite3) against a fresh in-memory database per case for isolation.
 *
 * Each case uses two values (an initial write followed by an update) so the
 * property covers both the initial-save round-trip (Requirements 1.6, 2.8) and
 * the update-overwrites-prior-value round-trip / last-write-wins (Requirements
 * 1.7, 2.9).
 */
describe('Property 4: Configuration persistence round-trip', () => {
  /** A fresh, seeded in-memory repository — isolates each generated case. */
  const freshRepo = (): Repository => new Repository(openDatabase(':memory:'));

  // Par is an integer 3..6 (types Par). (Requirement 1.2)
  const parArb = fc.constantFrom<Par>(3, 4, 5, 6);

  // Stroke index is an integer 1..18 (types StrokeIndex). (Requirement 1.3)
  const strokeIndexArb = fc.integer({
    min: STROKE_INDEX_MIN,
    max: STROKE_INDEX_MAX,
  }) as fc.Arbitrary<StrokeIndex>;

  // Hole ordinal 1..18 — which hole we save configuration against.
  const ordinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  // Playing handicap is a whole number 0..36 (types PlayingHandicap).
  // (Requirement 2.5)
  const handicapArb = fc.integer({
    min: HANDICAP_MIN,
    max: HANDICAP_MAX,
  }) as fc.Arbitrary<PlayingHandicap>;

  // Player name is a non-empty string of length 1..100. (Requirement 2.1)
  const nameArb = fc.string({
    minLength: PLAYER_NAME_MIN_LENGTH,
    maxLength: PLAYER_NAME_MAX_LENGTH,
  });

  it('round-trips a saved par, then reflects an updated par (Requirements 1.6, 1.7)', () => {
    fc.assert(
      fc.property(ordinalArb, parArb, parArb, (ordinal, firstPar, secondPar) => {
        const repo = freshRepo();

        repo.setPar(ordinal, firstPar);
        expect(repo.getHole(ordinal)?.par).toBe(firstPar);

        repo.setPar(ordinal, secondPar);
        expect(repo.getHole(ordinal)?.par).toBe(secondPar);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips a saved stroke index, then reflects an updated stroke index (Requirements 1.6, 1.7)', () => {
    fc.assert(
      fc.property(
        ordinalArb,
        strokeIndexArb,
        strokeIndexArb,
        (ordinal, firstSi, secondSi) => {
          const repo = freshRepo();

          repo.setStrokeIndex(ordinal, firstSi);
          expect(repo.getHole(ordinal)?.strokeIndex).toBe(firstSi);

          repo.setStrokeIndex(ordinal, secondSi);
          expect(repo.getHole(ordinal)?.strokeIndex).toBe(secondSi);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trips a created player name and both per-day handicaps (Requirement 2.8)', () => {
    fc.assert(
      fc.property(nameArb, handicapArb, handicapArb, (name, h1, h2) => {
        const repo = freshRepo();

        repo.createPlayer({
          id: 'p1',
          name,
          handicapDay1: h1,
          handicapDay2: h2,
        });

        expect(repo.getPlayer('p1')).toEqual({
          id: 'p1',
          name,
          handicapDay1: h1,
          handicapDay2: h2,
          cut: false,
          manualCut: false,
          orderDay1: 1,
          orderDay2: 1,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('reflects updates to a player name and both handicaps (Requirement 2.9)', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nameArb,
          handicapDay1: handicapArb,
          handicapDay2: handicapArb,
        }),
        fc.record({
          name: nameArb,
          handicapDay1: handicapArb,
          handicapDay2: handicapArb,
        }),
        (initial, updated) => {
          const repo = freshRepo();

          repo.createPlayer({ id: 'p1', ...initial });
          repo.updatePlayerDetails('p1', updated);

          expect(repo.getPlayer('p1')).toEqual({
            id: 'p1',
            name: updated.name,
            handicapDay1: updated.handicapDay1,
            handicapDay2: updated.handicapDay2,
            cut: false,
            manualCut: false,
            orderDay1: 1,
            orderDay2: 1,
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
/**
 * Feature: club-championship-scoring
 * Property 20: Score cell is last-write-wins
 *
 * Validates: Requirements 7.5, 7.6, 7.11, 7.12
 *
 * For any sequence of valid submissions (numeric or NR) to a single
 * (player, day, hole) cell, reading the cell afterward returns exactly the last
 * submitted value, with NR and numeric values freely replacing each other.
 *
 * This exercises Repository.upsertScore against a fresh in-memory database per
 * case. Because score.playerId has a foreign key to player(id), a player is
 * created first; the hole ordinals are already seeded by the schema migration.
 *
 * Scope: valid submissions only. Value validation (rejecting out-of-range
 * gross) is Property 19's concern; here every generated submission is a valid
 * numeric cell (gross in [GROSS_MIN, GROSS_MAX]) or NR.
 */
describe('Property 20: Score cell is last-write-wins', () => {
  /** A fresh in-memory repository seeded with one player for the target cell. */
  const freshRepoWithPlayer = (): Repository => {
    const repo = new Repository(openDatabase(':memory:'));
    repo.createPlayer({ id: 'p1', name: 'Target Player' });
    return repo;
  };

  // A valid numeric submission: gross in [GROSS_MIN, GROSS_MAX].
  const numericSubmissionArb: fc.Arbitrary<CellState> = fc
    .integer({ min: GROSS_MIN, max: GROSS_MAX })
    .map((gross) => numericCell(gross as Gross));

  // A valid NR submission.
  const nrSubmissionArb: fc.Arbitrary<CellState> = fc.constant(NO_RETURN);

  // Each submission is either numeric or NR, so numeric and NR both appear
  // across a sequence and freely replace each other.
  const submissionArb: fc.Arbitrary<CellState> = fc.oneof(
    numericSubmissionArb,
    nrSubmissionArb,
  );

  // A non-empty sequence of valid submissions applied in order to one cell.
  const submissionsArb = fc.array(submissionArb, { minLength: 1 });

  // Target cell coordinates: any day, any hole 1..18.
  const dayArb = fc.constantFrom<Day>(...DAYS);
  const cellOrdinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  it('reading a cell returns exactly the last submitted value (Requirements 7.5, 7.6, 7.11, 7.12)', () => {
    fc.assert(
      fc.property(
        dayArb,
        cellOrdinalArb,
        submissionsArb,
        (day, ordinal, submissions) => {
          const repo = freshRepoWithPlayer();

          for (const submission of submissions) {
            repo.upsertScore('p1', day, ordinal, submission);
          }

          const lastSubmission = submissions[submissions.length - 1];
          expect(repo.getCellState('p1', day, ordinal)).toEqual(lastSubmission);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 21: Cells are independent under concurrent writes
 *
 * Validates: Requirements 7.10, 7.13
 *
 * For any set of valid submissions targeting distinct (player, day, hole)
 * cells applied concurrently, every submission is persisted and no cell
 * clobbers another; recording NR on one hole of a day does not prevent numeric
 * entries on the remaining holes of that day.
 *
 * This exercises Repository.upsertScore against a fresh in-memory database per
 * case. Each score upsert runs in its own transaction keyed on the unique
 * (playerId, day, ordinal) cell, so submissions to distinct cells never
 * conflict. Because score.playerId has a foreign key to player(id), the players
 * referenced by the generated cells are created first.
 *
 * "Concurrently" is modelled by interleaving the writes in an arbitrary order
 * (via fc's shuffledSubarray) before reading everything back: the property must
 * hold regardless of the order in which independent writes are applied.
 *
 * Scope: valid submissions only (numeric gross in [GROSS_MIN, GROSS_MAX] or NR),
 * each targeting a distinct cell.
 */
describe('Property 21: Cells are independent under concurrent writes', () => {
  const freshRepo = (): Repository => new Repository(openDatabase(':memory:'));

  // A stable pool of player ids the generated cells may target.
  const PLAYER_IDS = ['p1', 'p2', 'p3', 'p4'] as const;

  const playerIdArb = fc.constantFrom(...PLAYER_IDS);
  const dayArb = fc.constantFrom<Day>(...DAYS);
  const ordinalArb = fc.constantFrom<HoleOrdinal>(...HOLE_ORDINALS);

  // A valid submission value: numeric gross in range, or NR.
  const valueArb: fc.Arbitrary<CellState> = fc.oneof(
    fc.integer({ min: GROSS_MIN, max: GROSS_MAX }).map((g) => numericCell(g as Gross)),
    fc.constant(NO_RETURN),
  );

  // One targeted cell plus the value to write there.
  interface Write {
    playerId: string;
    day: Day;
    ordinal: HoleOrdinal;
    value: CellState;
  }

  const writeArb: fc.Arbitrary<Write> = fc.record({
    playerId: playerIdArb,
    day: dayArb,
    ordinal: ordinalArb,
    value: valueArb,
  });

  const cellKey = (w: { playerId: string; day: Day; ordinal: HoleOrdinal }): string =>
    `${w.playerId}#${w.day}#${w.ordinal}`;

  // A set of writes to DISTINCT cells. uniqueArray with a cell-key selector
  // guarantees no two writes share a (playerId, day, ordinal) coordinate, so
  // the "distinct cells" precondition holds by construction.
  const distinctWritesArb = fc.uniqueArray(writeArb, {
    minLength: 1,
    maxLength: 40,
    selector: cellKey,
  });

  // A set of distinct-cell writes together with an arbitrary order in which to
  // apply them. Shuffling the same writes via fc.shuffledSubarray models the
  // independent submissions arriving interleaved/concurrently.
  const distinctWritesInOrderArb = distinctWritesArb.chain((writes) =>
    fc.record({
      writes: fc.constant(writes),
      order: fc.shuffledSubarray([...writes.keys()], {
        minLength: writes.length,
        maxLength: writes.length,
      }),
    }),
  );

  it('persists every write to a distinct cell regardless of apply order (Requirement 7.10)', () => {
    fc.assert(
      fc.property(distinctWritesInOrderArb, ({ writes, order }) => {
        const repo = freshRepo();
        for (const id of PLAYER_IDS) {
          repo.createPlayer({ id, name: `Player ${id}` });
        }

        // Apply the independent writes in an arbitrary interleaving to model
        // concurrent submission. Since each cell is distinct, order must not
        // matter — every value must survive with no clobbering.
        for (const idx of order) {
          const w = writes[idx];
          repo.upsertScore(w.playerId, w.day, w.ordinal, w.value);
        }

        for (const w of writes) {
          expect(repo.getCellState(w.playerId, w.day, w.ordinal)).toEqual(w.value);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('NR on one hole of a day does not block numeric entries on the other holes of that day (Requirement 7.13)', () => {
    fc.assert(
      fc.property(
        playerIdArb,
        dayArb,
        ordinalArb,
        // A numeric gross for every remaining hole of the day.
        fc.array(fc.integer({ min: GROSS_MIN, max: GROSS_MAX }), {
          minLength: HOLE_ORDINALS.length - 1,
          maxLength: HOLE_ORDINALS.length - 1,
        }),
        (playerId, day, nrOrdinal, grosses) => {
          const repo = freshRepo();
          for (const id of PLAYER_IDS) {
            repo.createPlayer({ id, name: `Player ${id}` });
          }

          // Record NR on one hole of the day.
          repo.upsertScore(playerId, day, nrOrdinal, NO_RETURN);

          // Then record numeric gross on every other hole of that day.
          const otherOrdinals = HOLE_ORDINALS.filter((o) => o !== nrOrdinal);
          otherOrdinals.forEach((ordinal, i) => {
            repo.upsertScore(playerId, day, ordinal, numericCell(grosses[i] as Gross));
          });

          // The NR is retained and every numeric entry was accepted/persisted.
          expect(repo.getCellState(playerId, day, nrOrdinal)).toEqual(NO_RETURN);
          otherOrdinals.forEach((ordinal, i) => {
            expect(repo.getCellState(playerId, day, ordinal)).toEqual(
              numericCell(grosses[i] as Gross),
            );
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
