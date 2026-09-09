import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HANDICAP_MAX,
  HANDICAP_MIN,
  isErr,
  isOk,
  type Day,
  type Player,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 6: Handicap validation and per-day independence
 *
 * Validates: Requirements 2.5, 2.6, 2.7
 *
 * For any pair of values, each per-day handicap is accepted and stored if and
 * only if it is an integer in [0, 36]; setting one day's handicap never changes
 * the other day's stored handicap, and rejection retains the previously stored
 * value.
 *
 * This exercises CompetitionSetupService.setHandicap on top of the real
 * Repository, using a fresh in-memory database per case for isolation.
 * Read-back is via repository.getPlayer so the accept branch is verified
 * through the same persistence path the service uses, and the reject branch
 * confirms the persisted handicap is untouched (retain-on-reject).
 */
describe('Property 6: Handicap validation and per-day independence', () => {
  /** A fresh service over a fresh in-memory repository. */
  const freshService = (): {
    service: CompetitionSetupService;
    repo: Repository;
  } => {
    const repo = new Repository(openDatabase(':memory:'));
    return { service: new CompetitionSetupService(repo), repo };
  };

  /** Create a player via the service and return its id. */
  const seedPlayer = (
    service: CompetitionSetupService,
    name: string,
  ): string => {
    const created = service.addPlayer(name);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) throw new Error('failed to seed player');
    return created.value.id;
  };

  // A name whose length is a valid 1..100. Used only to obtain a player to
  // hang handicaps on; not the subject under test.
  const validNameArb = fc.string({
    minLength: 1,
    maxLength: 100,
    unit: 'grapheme',
  });

  // A day selector (1 or 2) — fast-check arbitrary, no hand-rolled values.
  const dayArb = fc.constantFrom<Day>(1, 2);

  // Candidate handicap spanning the whole input space:
  //  - integers in [0, 36]           -> accept-eligible
  //  - integers outside [0, 36]      -> reject (negative and > 36)
  //  - non-integer doubles           -> reject
  const candidateHandicapArb = fc.oneof(
    fc.integer({ min: HANDICAP_MIN, max: HANDICAP_MAX }), // in-range integers
    fc.integer({ min: -100, max: HANDICAP_MIN - 1 }), // below range
    fc.integer({ min: HANDICAP_MAX + 1, max: 200 }), // above range
    fc
      .double({ min: -100, max: 200, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n)), // non-integers
  );

  /** True iff `value` is an integer within the inclusive [0, 36] range. */
  const isAcceptable = (value: number): boolean =>
    Number.isInteger(value) && value >= HANDICAP_MIN && value <= HANDICAP_MAX;

  it('accepts and persists a per-day handicap iff it is an integer in [0, 36], otherwise rejects and retains (Requirements 2.5, 2.6)', () => {
    fc.assert(
      fc.property(
        validNameArb,
        dayArb,
        candidateHandicapArb,
        (name, day, candidate) => {
          const { service, repo } = freshService();
          const playerId = seedPlayer(service, name);

          // Baseline: both handicaps start unset.
          const before = repo.getPlayer(playerId);
          expect(before).toBeTruthy();
          const beforeDay1 = before?.handicapDay1 ?? null;
          const beforeDay2 = before?.handicapDay2 ?? null;

          const result = service.setHandicap(playerId, day, candidate);

          if (isAcceptable(candidate)) {
            // Accept branch: ok, and the targeted day round-trips through the
            // repository with the candidate value; the other day is untouched.
            expect(isOk(result)).toBe(true);
            if (isOk(result)) {
              const updated: Player = result.value;
              if (day === 1) {
                expect(updated.handicapDay1).toBe(candidate);
                expect(updated.handicapDay2).toBe(beforeDay2);
              } else {
                expect(updated.handicapDay2).toBe(candidate);
                expect(updated.handicapDay1).toBe(beforeDay1);
              }
            }
            const persisted = repo.getPlayer(playerId);
            if (day === 1) {
              expect(persisted?.handicapDay1).toBe(candidate);
              expect(persisted?.handicapDay2).toBe(beforeDay2);
            } else {
              expect(persisted?.handicapDay2).toBe(candidate);
              expect(persisted?.handicapDay1).toBe(beforeDay1);
            }
          } else {
            // Reject branch: OUT_OF_RANGE with a message naming the permitted
            // range, and the stored handicaps are retained unchanged.
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.code).toBe('OUT_OF_RANGE');
              expect(result.error).toContain(String(HANDICAP_MIN));
              expect(result.error).toContain(String(HANDICAP_MAX));
            }
            const persisted = repo.getPlayer(playerId);
            expect(persisted?.handicapDay1).toBe(beforeDay1);
            expect(persisted?.handicapDay2).toBe(beforeDay2);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('stores Day 1 and Day 2 handicaps independently: setting one never disturbs the other, across accept and reject (Requirement 2.7)', () => {
    fc.assert(
      fc.property(
        validNameArb,
        dayArb,
        fc.integer({ min: HANDICAP_MIN, max: HANDICAP_MAX }), // seed value (valid)
        candidateHandicapArb, // second value (may accept or reject)
        (name, seedDay, seedValue, secondValue) => {
          const { service, repo } = freshService();
          const playerId = seedPlayer(service, name);

          // Seed one day with a known valid handicap.
          const seeded = service.setHandicap(playerId, seedDay, seedValue);
          expect(isOk(seeded)).toBe(true);

          const otherDay: Day = seedDay === 1 ? 2 : 1;
          const afterSeed = repo.getPlayer(playerId);
          const seededDayValue =
            seedDay === 1 ? afterSeed?.handicapDay1 : afterSeed?.handicapDay2;
          expect(seededDayValue).toBe(seedValue);

          // Attempt to set the OTHER day with the (possibly invalid) second value.
          service.setHandicap(playerId, otherDay, secondValue);

          // Regardless of accept/reject on the other day, the seeded day is
          // preserved exactly.
          const persisted = repo.getPlayer(playerId);
          const preservedSeedValue =
            seedDay === 1 ? persisted?.handicapDay1 : persisted?.handicapDay2;
          expect(preservedSeedValue).toBe(seedValue);

          // And the other day reflects the second value only when it was valid.
          const otherStored =
            otherDay === 1 ? persisted?.handicapDay1 : persisted?.handicapDay2;
          if (isAcceptable(secondValue)) {
            expect(otherStored).toBe(secondValue);
          } else {
            // Reject retains the other day's previous value (still unset).
            expect(otherStored).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
