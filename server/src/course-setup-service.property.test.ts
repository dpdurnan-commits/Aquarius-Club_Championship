import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PAR_MAX,
  PAR_MIN,
  isErr,
  isOk,
  type HoleOrdinal,
  type Par,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CourseSetupService } from './course-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 1: Par validation is exactly the range 3..6
 *
 * Validates: Requirements 1.2, 1.5
 *
 * For any value, `setPar` accepts it and stores it if and only if it is an
 * integer in [PAR_MIN, PAR_MAX] (3..6); for any rejected value (empty,
 * non-integer, or out-of-range) the previously stored par is unchanged
 * (retain-on-reject) and an error carrying the permitted range is returned.
 *
 * This exercises CourseSetupService.setPar on top of the Repository, using a
 * fresh in-memory database per case for isolation. Read-back is via getHoles()
 * so the accept branch is verified through the same persistence path the
 * service uses.
 */
describe('Property 1: Par validation is exactly the range 3..6', () => {
  /** A fresh service over a fresh, seeded in-memory repository. */
  const freshService = (): { service: CourseSetupService; repo: Repository } => {
    const repo = new Repository(openDatabase(':memory:'));
    return { service: new CourseSetupService(repo), repo };
  };

  // Hole ordinal 1..18 — which hole we configure.
  const ordinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  // A par that is a valid integer in [3, 6] — the accept branch.
  const validParArb = fc.integer({ min: PAR_MIN, max: PAR_MAX }) as fc.Arbitrary<Par>;

  // Read the currently stored par for a hole via the service's getHoles().
  const storedPar = (service: CourseSetupService, ordinal: HoleOrdinal): Par | null => {
    const hole = service.getHoles().find((h) => h.ordinal === ordinal);
    return (hole?.par ?? null) as Par | null;
  };

  it('accepts and persists a value iff it is an integer in [PAR_MIN, PAR_MAX] (Requirement 1.2)', () => {
    // Candidate values span accept (3..6) and reject (out-of-range integers,
    // boundary cases 2 and 7, non-integers, and NaN) so the biconditional is
    // exercised on both sides.
    const candidateArb = fc.oneof(
      fc.integer({ min: PAR_MIN, max: PAR_MAX }), // accept: 3..6
      fc.constantFrom(2, 7), // reject: immediate out-of-range boundaries
      fc.integer({ min: -50, max: 50 }), // reject/accept: mixed integers
      fc.double({ noNaN: false }), // reject: floats and NaN
    ) as fc.Arbitrary<Par>;

    fc.assert(
      fc.property(ordinalArb, candidateArb, (ordinal, candidate) => {
        const { service } = freshService();

        const result = service.setPar(ordinal, candidate);

        const isValid =
          typeof candidate === 'number' &&
          Number.isInteger(candidate) &&
          candidate >= PAR_MIN &&
          candidate <= PAR_MAX;

        if (isValid) {
          // Accept branch: ok and the value is persisted (read-back matches).
          expect(isOk(result)).toBe(true);
          expect(storedPar(service, ordinal)).toBe(candidate);
        } else {
          // Reject branch: error carrying the permitted range; nothing stored.
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.code).toBe('OUT_OF_RANGE');
            expect(result.error).toContain(String(PAR_MIN));
            expect(result.error).toContain(String(PAR_MAX));
          }
          // Nothing was previously stored, so par remains unset (null).
          expect(storedPar(service, ordinal)).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('retains the previously stored par when a subsequent invalid value is rejected (Requirement 1.5)', () => {
    // A value that is guaranteed invalid: out-of-range integers (incl. 2 and 7)
    // and non-integers/NaN. Never lands in [3, 6].
    const invalidParArb = fc.oneof(
      fc.constantFrom(2, 7),
      fc.integer({ min: PAR_MAX + 1, max: 100 }),
      fc.integer({ min: -100, max: PAR_MIN - 1 }),
      fc.double({ noNaN: false }).filter((n) => !Number.isInteger(n)),
    ) as fc.Arbitrary<Par>;

    fc.assert(
      fc.property(ordinalArb, validParArb, invalidParArb, (ordinal, good, bad) => {
        const { service } = freshService();

        // First store a known-good value.
        const accepted = service.setPar(ordinal, good);
        expect(isOk(accepted)).toBe(true);
        expect(storedPar(service, ordinal)).toBe(good);

        // A subsequent invalid entry must be rejected and must not change it.
        const rejected = service.setPar(ordinal, bad);
        expect(isErr(rejected)).toBe(true);
        if (isErr(rejected)) {
          expect(rejected.code).toBe('OUT_OF_RANGE');
          expect(rejected.error).toContain(String(PAR_MIN));
          expect(rejected.error).toContain(String(PAR_MAX));
        }

        // Retain-on-reject: the previously stored par is unchanged.
        expect(storedPar(service, ordinal)).toBe(good);
      }),
      { numRuns: 100 },
    );
  });
});
