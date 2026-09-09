import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
  isErr,
  isOk,
  type Player,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 5: Player name validation is length 1..100 plus uniqueness
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * For any roster and candidate name, adding the player via
 * CompetitionSetupService.addPlayer is accepted if and only if the name length
 * is in [1, 100] and does not duplicate an existing name; on rejection the
 * roster is left unchanged (retain-on-reject).
 *
 * This exercises CompetitionSetupService.addPlayer on top of the Repository,
 * using a fresh in-memory database per case for isolation. Read-back is via
 * getPlayers() so the accept branch is verified through the same persistence
 * path the service uses, and the reject branch confirms the persisted roster is
 * untouched.
 */
describe('Property 5: Player name validation is length 1..100 plus uniqueness', () => {
  /** A fresh service over a fresh, seeded in-memory repository. */
  const freshService = (): { service: CompetitionSetupService; repo: Repository } => {
    const repo = new Repository(openDatabase(':memory:'));
    return { service: new CompetitionSetupService(repo), repo };
  };

  /** The sorted set of names currently stored in the roster. */
  const rosterNames = (repo: Repository): string[] =>
    repo
      .getPlayers()
      .map((player) => player.name)
      .sort();

  // A name whose length is exactly 1..100 (the length-valid space). Includes the
  // boundaries (1 and 100) so accept/reject at the edges is exercised. Uses the
  // full-unicode string generator so multi-byte and whitespace names are covered.
  const validLengthNameArb = fc.string({
    minLength: PLAYER_NAME_MIN_LENGTH,
    maxLength: PLAYER_NAME_MAX_LENGTH,
    unit: 'grapheme',
  });

  it('accepts and persists a candidate iff its length is in [1, 100] and it is not a duplicate (Requirements 2.1, 2.2, 2.3)', () => {
    // A candidate spanning the whole input space: length-valid names, the
    // empty string (too short), and over-length names (>100). fast-check
    // generators only — no hand-rolled strings.
    const candidateArb = fc.oneof(
      validLengthNameArb, // accept-eligible (subject to uniqueness)
      fc.constant(''), // reject: empty (length 0)
      fc.string({ minLength: PLAYER_NAME_MAX_LENGTH + 1, maxLength: 200 }), // reject: over-length
    );

    // A prior roster: 0..5 length-valid, distinct names seeded before the
    // candidate is offered, so the duplicate branch is reached organically.
    const priorNamesArb = fc.uniqueArray(validLengthNameArb, {
      minLength: 0,
      maxLength: 5,
    });

    fc.assert(
      fc.property(priorNamesArb, candidateArb, (priorNames, candidate) => {
        const { service, repo } = freshService();

        // Seed the roster with the prior names (each is length-valid + unique).
        for (const name of priorNames) {
          const seeded = service.addPlayer(name);
          expect(isOk(seeded)).toBe(true);
        }
        const before = rosterNames(repo);

        const result = service.addPlayer(candidate);

        const lengthValid =
          candidate.length >= PLAYER_NAME_MIN_LENGTH &&
          candidate.length <= PLAYER_NAME_MAX_LENGTH;
        const isDuplicate = before.includes(candidate);
        const shouldAccept = lengthValid && !isDuplicate;

        if (shouldAccept) {
          // Accept branch: ok, the created player carries the candidate name,
          // and the roster now contains it exactly once.
          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            const created: Player = result.value;
            expect(created.name).toBe(candidate);
          }
          expect(rosterNames(repo)).toEqual([...before, candidate].sort());
        } else {
          // Reject branch: an error is returned and the roster is unchanged.
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            if (!lengthValid) {
              // Empty / over-length reports the permitted length. (2.2)
              expect(result.code).toBe('EMPTY');
              expect(result.error).toContain(String(PLAYER_NAME_MIN_LENGTH));
              expect(result.error).toContain(String(PLAYER_NAME_MAX_LENGTH));
            } else {
              // A duplicate reports the name is already in use. (2.3)
              expect(result.code).toBe('DUPLICATE');
            }
          }
          // Retain-on-reject: the roster is exactly what it was before.
          expect(rosterNames(repo)).toEqual(before);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a name that duplicates an existing player and retains the existing player unchanged (Requirement 2.3)', () => {
    fc.assert(
      fc.property(validLengthNameArb, (name) => {
        const { service, repo } = freshService();

        // First add succeeds and records the player.
        const first = service.addPlayer(name);
        expect(isOk(first)).toBe(true);
        const before = repo.getPlayers();
        expect(before).toHaveLength(1);

        // A second add with the same name is rejected as a duplicate...
        const second = service.addPlayer(name);
        expect(isErr(second)).toBe(true);
        if (isErr(second)) {
          expect(second.code).toBe('DUPLICATE');
        }

        // ...and the existing player is retained unchanged (still exactly one,
        // same id and name).
        const after = repo.getPlayers();
        expect(after).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });
});
