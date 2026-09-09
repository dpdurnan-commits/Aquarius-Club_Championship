import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isErr, isOk } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 16: Cut value validation gates completion
 *
 * Validates: Requirements 3.2, 3.3
 *
 * For any cut value, marking Day 1 complete succeeds if and only if the value
 * is a positive integer; on rejection the Day_1_Complete status remains unset
 * and no cut state changes.
 *
 * This exercises CompetitionSetupService.markDay1Complete on top of the real
 * Repository, using a fresh in-memory database per case for isolation. The
 * accept branch is verified through the same persistence path the service uses
 * (read-back via repository.getCompetitionState), and the reject branch
 * confirms the competition state and every player's cut flag are untouched.
 */
describe('Property 16: Cut value validation gates completion', () => {
  /** A fresh service over a fresh in-memory repository. */
  const freshService = (): {
    service: CompetitionSetupService;
    repo: Repository;
  } => {
    const repo = new Repository(openDatabase(':memory:'));
    return { service: new CompetitionSetupService(repo), repo };
  };

  /** Seed a roster so there is real cut state to (not) disturb on rejection. */
  const seedPlayers = (service: CompetitionSetupService, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const created = service.addPlayer(`Player ${i}`);
      expect(isOk(created)).toBe(true);
    }
  };

  // Candidate cut value spanning the whole input space:
  //  - positive integers (>= 1)      -> accept-eligible
  //  - zero and negative integers    -> reject
  //  - non-integer doubles           -> reject
  const candidateCutValueArb = fc.oneof(
    fc.integer({ min: 1, max: 1000 }), // positive integers
    fc.integer({ min: -1000, max: 0 }), // zero and negatives
    fc
      .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n)), // non-integers
  );

  /** True iff `value` is a positive integer (>= 1). */
  const isAcceptable = (value: number): boolean =>
    Number.isInteger(value) && value >= 1;

  it('marks Day 1 complete iff the cut value is a positive integer, otherwise rejects leaving status unset and cut state unchanged (Requirements 3.2, 3.3)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        candidateCutValueArb,
        (playerCount, candidate) => {
          const { service, repo } = freshService();
          seedPlayers(service, playerCount);

          // Baseline: Day 1 is not complete, no cut value, no player cut.
          const before = repo.getCompetitionState();
          expect(before.day1Complete).toBe(false);
          expect(before.cutValue).toBeNull();
          const cutBefore = repo
            .getPlayers()
            .map((p) => [p.id, p.cut] as const);
          expect(cutBefore.every(([, cut]) => cut === false)).toBe(true);

          const result = service.markDay1Complete(candidate);

          if (isAcceptable(candidate)) {
            // Accept branch: ok, Day 1 complete is set, and the cut value is
            // persisted through the repository.
            expect(isOk(result)).toBe(true);
            const after = repo.getCompetitionState();
            expect(after.day1Complete).toBe(true);
            expect(after.cutValue).toBe(candidate);
          } else {
            // Reject branch: INVALID with a message naming the positive-integer
            // requirement, and NO state changes — status stays unset, cut value
            // stays null, and every player's cut flag is retained unchanged.
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.code).toBe('INVALID');
              expect(result.error.toLowerCase()).toContain(
                'positive integer',
              );
            }
            const after = repo.getCompetitionState();
            expect(after.day1Complete).toBe(false);
            expect(after.cutValue).toBeNull();
            const cutAfter = repo
              .getPlayers()
              .map((p) => [p.id, p.cut] as const);
            expect(cutAfter).toEqual(cutBefore);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
