import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  GROSS_MAX,
  GROSS_MIN,
  isErr,
  type CellState,
  type HoleOrdinal,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { ScoreEntryService, NR_TOKEN, type ScoreSubmission } from './score-entry-service.js';

/**
 * Feature: club-championship-scoring
 * Property 22: Cut players cannot receive Day 2 scores
 *
 * Validates: Requirements 7.14
 *
 * For any player with CUT status, every Day 2 numeric (1..20) or NR submission
 * is rejected, no Day 2 cell is persisted for that (player, hole), and a
 * message indicating the player is cut is returned.
 *
 * This drives the real ScoreEntryService over a fresh in-memory SQLite
 * Repository per case, with a single seeded player whose cut flag is set to
 * true. The submission spans the full accepted input space (integers in [1, 20]
 * and the NR token), because 7.14 gates only *otherwise-valid* Day 2 entries.
 * Each case verifies:
 *  - the result is an error (rejected),
 *  - the error carries the PLAYER_CUT code and a "cut" message, and
 *  - the target Day 2 cell remains unrecorded (nothing was persisted).
 */
describe('Property 22: Cut players cannot receive Day 2 scores', () => {
  /** A fresh service over a fresh in-memory repository with one CUT player. */
  const freshStack = (): { service: ScoreEntryService; repo: Repository } => {
    const repo = new Repository(openDatabase(':memory:'));
    repo.createPlayer({ id: 'p1', name: 'Cut Player' });
    repo.setPlayerCut('p1', true);
    return { service: new ScoreEntryService(repo), repo };
  };

  // A Day 2 submission drawn from the accepted input space: any integer in the
  // permitted gross range or the NR token. 7.14 rejects these solely on account
  // of CUT status, not on account of value validity.
  const day2SubmissionArb: fc.Arbitrary<ScoreSubmission> = fc.oneof(
    fc.integer({ min: GROSS_MIN, max: GROSS_MAX }),
    fc.constant<ScoreSubmission>(NR_TOKEN),
  );

  const unrecorded: CellState = { kind: 'unrecorded' };

  it('rejects every Day 2 numeric or NR submission for a CUT player, persists no Day 2 cell, and returns a "player is cut" message (Requirement 7.14)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 18 }).map((n) => n as HoleOrdinal),
        day2SubmissionArb,
        (ordinal, submission) => {
          const { service, repo } = freshStack();

          // Precondition: the Day 2 cell starts unrecorded.
          expect(repo.getCellState('p1', 2, ordinal)).toEqual(unrecorded);

          const result = service.submitScore('p1', 2, ordinal, submission);

          // Rejected with a cut indication.
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.code).toBe('PLAYER_CUT');
            expect(result.error.toLowerCase()).toContain('cut');
          }

          // No Day 2 cell was persisted for that hole.
          expect(repo.getCellState('p1', 2, ordinal)).toEqual(unrecorded);
        },
      ),
      { numRuns: 100 },
    );
  });
});
