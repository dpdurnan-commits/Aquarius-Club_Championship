import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isOk, type Day, type Gross, type HoleOrdinal } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';
import { ScoreEntryService } from './score-entry-service.js';

/**
 * Feature: club-championship-scoring
 * Property 17: No cut before completion
 *
 * Validates: Requirements 3.8
 *
 * For any state in which Day 1 is not marked complete, no player has CUT status.
 *
 * This drives the real CompetitionSetupService (and ScoreEntryService) over a
 * fresh in-memory SQLite Repository per case. It exercises the whole space of
 * states that leave Day_1_Complete unset:
 *  - the fresh/default state (nothing done yet),
 *  - after adding players and setting per-day handicaps,
 *  - after entering arbitrary Day 1 scores (numeric / NR),
 *  - after a rejected mark-complete (invalid, non-positive-integer cut value),
 *  - after a mark-complete with a valid cut value that is then reversed.
 * In every such state the property asserts Day_1_Complete is false and every
 * player's CUT status (read back through the repository) is false.
 */
describe('Property 17: No cut before completion', () => {
  /** A fresh service stack over a fresh in-memory repository (18 holes seeded). */
  const freshStack = (): {
    setup: CompetitionSetupService;
    scores: ScoreEntryService;
    repo: Repository;
  } => {
    const repo = new Repository(openDatabase(':memory:'));
    return {
      setup: new CompetitionSetupService(repo),
      scores: new ScoreEntryService(repo),
      repo,
    };
  };

  /** Assert Day 1 is not complete and no player carries CUT status. */
  const expectNoCutBeforeCompletion = (repo: Repository): void => {
    expect(repo.getCompetitionState().day1Complete).toBe(false);
    for (const player of repo.getPlayers()) {
      expect(player.cut).toBe(false);
    }
  };

  // A hole ordinal in the seeded 1..18 range.
  const ordinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  // A valid score submission: a gross in [1, 20] or the NR token.
  const submissionArb = fc.oneof(
    fc.integer({ min: 1, max: 20 }).map((g) => g as Gross),
    fc.constant('NR' as const),
  );

  // A cut value that is NOT a positive integer, so mark-complete is rejected
  // and Day_1_Complete stays unset (zero, negatives, and non-integers).
  const invalidCutValueArb = fc.oneof(
    fc.integer({ min: -1000, max: 0 }),
    fc
      .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n)),
  );

  // A valid cut value (positive integer) for the mark-then-reverse path.
  const validCutValueArb = fc.integer({ min: 1, max: 1000 });

  it('leaves every player without CUT status while Day 1 is not marked complete (Requirement 3.8)', () => {
    fc.assert(
      fc.property(
        // A roster of distinct player names.
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 0,
          maxLength: 8,
        }),
        // Arbitrary Day 1 score entries: (playerIndex, ordinal, value).
        fc.array(
          fc.tuple(fc.nat(), ordinalArb, submissionArb),
          { maxLength: 30 },
        ),
        invalidCutValueArb,
        validCutValueArb,
        fc.boolean(), // whether to exercise the mark-then-reverse path
        (names, entries, invalidCut, validCut, doReverseCycle) => {
          const { setup, scores, repo } = freshStack();

          // Fresh/default state: no players, Day 1 not complete, nobody cut.
          expectNoCutBeforeCompletion(repo);

          // Add players (names are unique, so each add succeeds) and set both
          // per-day handicaps for each.
          const playerIds: string[] = [];
          for (const name of names) {
            const created = setup.addPlayer(name);
            expect(isOk(created)).toBe(true);
            if (isOk(created)) {
              playerIds.push(created.value.id);
              setup.setHandicap(created.value.id, 1 as Day, 12 as never);
              setup.setHandicap(created.value.id, 2 as Day, 18 as never);
            }
          }
          expectNoCutBeforeCompletion(repo);

          // Enter arbitrary Day 1 scores. Adding scores must never trigger a cut.
          if (playerIds.length > 0) {
            for (const [rawIndex, ordinal, value] of entries) {
              const playerId = playerIds[rawIndex % playerIds.length];
              scores.submitScore(playerId, 1 as Day, ordinal, value);
            }
          }
          expectNoCutBeforeCompletion(repo);

          // A rejected mark-complete (non-positive-integer cut value) must not
          // set Day_1_Complete nor apply any cut.
          setup.markDay1Complete(invalidCut);
          expectNoCutBeforeCompletion(repo);

          // Marking complete with a valid cut value and then reversing it must
          // return to a state where Day 1 is not complete and nobody is cut.
          if (doReverseCycle) {
            setup.markDay1Complete(validCut);
            setup.reverseDay1Complete();
            expectNoCutBeforeCompletion(repo);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
