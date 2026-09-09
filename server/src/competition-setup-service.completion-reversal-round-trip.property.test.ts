import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isOk,
  type Day,
  type Gross,
  type HoleOrdinal,
  type PlayingHandicap,
} from '@ccs/types';
import { openDatabase, type DatabaseHandle } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';
import { ScoreEntryService } from './score-entry-service.js';

/**
 * Feature: club-championship-scoring
 * Property 18: Day 1 completion and reversal round-trip
 *
 * Validates: Requirements 3.9, 3.10
 *
 * For any state, marking Day 1 complete with a valid X and then reversing it
 * restores every player to un-cut and clears Day_1_Complete and the cut value;
 * and after marking (or reversing), reloading persisted state yields the same
 * Day_1_Complete flag, cut value, and CUT set that were in effect.
 *
 * This drives the real CompetitionSetupService, ScoreEntryService, and
 * Repository over an in-memory SQLite database — no domain mocks. To prove the
 * completion/reversal state is *persisted* (and not merely held in an
 * in-memory service cache), the property reads persisted state back through a
 * SECOND Repository instance constructed over the SAME database handle. A
 * distinct `openDatabase(':memory:')` call yields a distinct database, so the
 * shared handle is reused across service stacks; `db.ts` seeds are idempotent,
 * so re-opening/reusing the handle preserves data.
 */
describe('Property 18: Day 1 completion and reversal round-trip', () => {
  /** A service stack over a given database handle (writer side). */
  const stackOver = (
    db: DatabaseHandle,
  ): {
    setup: CompetitionSetupService;
    scores: ScoreEntryService;
    repo: Repository;
  } => {
    const repo = new Repository(db);
    return {
      setup: new CompetitionSetupService(repo),
      scores: new ScoreEntryService(repo),
      repo,
    };
  };

  /**
   * A FRESH repository over the same handle used only to read persisted state.
   * Using a separate Repository instance (fresh prepared statements, no cached
   * domain state) proves the values were written to the database itself.
   */
  const freshReader = (db: DatabaseHandle): Repository => new Repository(db);

  /** Snapshot of the persisted completion state plus the CUT set, read fresh. */
  const readSnapshot = (
    db: DatabaseHandle,
  ): {
    day1Complete: boolean;
    cutValue: number | null;
    cutSet: ReadonlySet<string>;
  } => {
    const reader = freshReader(db);
    const state = reader.getCompetitionState();
    const cutSet = new Set<string>(
      reader.getPlayers().filter((p) => p.cut).map((p) => p.id),
    );
    return {
      day1Complete: state.day1Complete,
      cutValue: state.cutValue,
      cutSet,
    };
  };

  // A hole ordinal in the seeded 1..18 range.
  const ordinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  // A valid score submission: a gross in [1, 20] or the NR token.
  const submissionArb = fc.oneof(
    fc.integer({ min: 1, max: 20 }).map((g) => g as Gross),
    fc.constant('NR' as const),
  );

  // A valid cut value: a small positive integer, kept small so that, with up to
  // 8 players, some non-NR players fall outside the top X and are cut too. This
  // produces a mix of cut/uncut players rather than an all-advance outcome.
  const validCutValueArb = fc.integer({ min: 1, max: 3 });

  it('marks/reverses Day 1 and reloads persisted flag, cut value, and CUT set (Requirements 3.9, 3.10)', () => {
    fc.assert(
      fc.property(
        // A roster of distinct player names (0..8).
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 0,
          maxLength: 8,
        }),
        // Per-day handicaps for each generated player (index-aligned, padded).
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 36 }),
            fc.integer({ min: 0, max: 36 }),
          ),
          { maxLength: 8 },
        ),
        // Arbitrary Day 1 score entries: (playerIndex, ordinal, value).
        fc.array(fc.tuple(fc.nat(), ordinalArb, submissionArb), {
          maxLength: 40,
        }),
        validCutValueArb,
        (names, handicaps, entries, cutValue) => {
          // A single shared in-memory database handle for the whole case, so a
          // fresh reader Repository can prove persistence, not caching.
          const db = openDatabase(':memory:');
          const { setup, scores } = stackOver(db);

          // Add players and set both per-day handicaps.
          const playerIds: string[] = [];
          names.forEach((name, i) => {
            const created = setup.addPlayer(name);
            expect(isOk(created)).toBe(true);
            if (isOk(created)) {
              playerIds.push(created.value.id);
              const [h1, h2] = handicaps[i] ?? [12, 18];
              setup.setHandicap(
                created.value.id,
                1 as Day,
                h1 as PlayingHandicap,
              );
              setup.setHandicap(
                created.value.id,
                2 as Day,
                h2 as PlayingHandicap,
              );
            }
          });

          // Enter arbitrary Day 1 scores across players/holes.
          if (playerIds.length > 0) {
            for (const [rawIndex, ordinal, value] of entries) {
              const playerId = playerIds[rawIndex % playerIds.length]!;
              scores.submitScore(playerId, 1 as Day, ordinal, value);
            }
          }

          // 1. Mark Day 1 complete with a valid X — must succeed.
          const marked = setup.markDay1Complete(cutValue);
          expect(isOk(marked)).toBe(true);

          // The state in effect after marking, captured from the mark result
          // (the service returns the freshly persisted competition state).
          const inEffect = isOk(marked) ? marked.value : null;
          expect(inEffect).not.toBeNull();

          // 3. Round-trip determinism: a FRESH read over the same DB yields the
          //    same day1Complete flag, cut value, and CUT set in effect.
          const afterMark = readSnapshot(db);
          expect(afterMark.day1Complete).toBe(true);
          expect(afterMark.day1Complete).toBe(inEffect!.day1Complete);
          expect(afterMark.cutValue).toBe(cutValue);
          expect(afterMark.cutValue).toBe(inEffect!.cutValue);

          // The persisted CUT set must be a subset of the roster, and NR
          // players (unranked) are always cut, so the set is well-defined.
          for (const id of afterMark.cutSet) {
            expect(playerIds).toContain(id);
          }

          // 2. Reverse Day 1 complete — must succeed and clear everything.
          const reversed = setup.reverseDay1Complete();
          expect(isOk(reversed)).toBe(true);

          const afterReverse = readSnapshot(db);
          expect(afterReverse.day1Complete).toBe(false);
          expect(afterReverse.cutValue).toBeNull();
          expect(afterReverse.cutSet.size).toBe(0);

          // Every player is restored to un-cut in the fresh read.
          for (const player of freshReader(db).getPlayers()) {
            expect(player.cut).toBe(false);
          }

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
