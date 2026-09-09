import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  STROKE_INDEX_MAX,
  STROKE_INDEX_MIN,
  isErr,
  isOk,
  type HoleOrdinal,
  type StrokeIndex,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CourseSetupService } from './course-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 2: Stroke index validation is the range 1..18 plus uniqueness
 *
 * Validates: Requirements 1.3, 1.4, 1.5
 *
 * For any course state and any stroke-index assignment, the assignment is
 * accepted if and only if the value is an integer in [1, 18] (1.3) AND not
 * already held by another hole (1.4). On rejection the stored set of stroke
 * indices is unchanged (retain-on-reject, 1.5) and, for a duplicate, the
 * conflicting hole ordinal is identified in the returned error (1.4).
 *
 * This exercises CourseSetupService.setStrokeIndex on top of the Repository,
 * using a fresh in-memory database per case for isolation. Read-back is via
 * getHoles() so the accept branch is verified through the same persistence path
 * the service uses.
 */
describe('Property 2: Stroke index validation is the range 1..18 plus uniqueness', () => {
  /** A fresh service over a fresh, seeded in-memory repository. */
  const freshService = (): { service: CourseSetupService; repo: Repository } => {
    const repo = new Repository(openDatabase(':memory:'));
    return { service: new CourseSetupService(repo), repo };
  };

  // Hole ordinal 1..18 — which hole we configure.
  const ordinalArb = fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<HoleOrdinal>;

  // A stroke index that is a valid integer in [1, 18] — the accept branch.
  const validStrokeIndexArb = fc.integer({
    min: STROKE_INDEX_MIN,
    max: STROKE_INDEX_MAX,
  }) as fc.Arbitrary<StrokeIndex>;

  /** The multiset of stored stroke indices across all 18 holes, in ordinal order. */
  const storedStrokeIndices = (service: CourseSetupService): (number | null)[] =>
    service.getHoles().map((h) => (h.strokeIndex ?? null) as number | null);

  /** Read the currently stored stroke index for a hole via getHoles(). */
  const storedStrokeIndex = (
    service: CourseSetupService,
    ordinal: HoleOrdinal,
  ): StrokeIndex | null => {
    const hole = service.getHoles().find((h) => h.ordinal === ordinal);
    return (hole?.strokeIndex ?? null) as StrokeIndex | null;
  };

  it('accepts and persists a value iff it is an integer in [1, 18] and unused (Requirements 1.3, 1.4)', () => {
    // Candidate values span accept (1..18) and reject (out-of-range integers,
    // boundary cases 0 and 19, non-integers, and NaN) so the range half of the
    // biconditional is exercised on both sides against an empty course.
    const candidateArb = fc.oneof(
      fc.integer({ min: STROKE_INDEX_MIN, max: STROKE_INDEX_MAX }), // accept: 1..18
      fc.constantFrom(0, 19), // reject: immediate out-of-range boundaries
      fc.integer({ min: -50, max: 50 }), // reject/accept: mixed integers
      fc.double({ noNaN: false }), // reject: floats and NaN
    ) as fc.Arbitrary<StrokeIndex>;

    fc.assert(
      fc.property(ordinalArb, candidateArb, (ordinal, candidate) => {
        const { service } = freshService();

        const result = service.setStrokeIndex(ordinal, candidate);

        // On an empty course there is no other hole holding a value, so
        // acceptance reduces to the range check alone.
        const isValidRange =
          typeof candidate === 'number' &&
          Number.isInteger(candidate) &&
          candidate >= STROKE_INDEX_MIN &&
          candidate <= STROKE_INDEX_MAX;

        if (isValidRange) {
          // Accept branch: ok and the value is persisted (read-back matches).
          expect(isOk(result)).toBe(true);
          expect(storedStrokeIndex(service, ordinal)).toBe(candidate);
        } else {
          // Reject branch: out-of-range error carrying the permitted range.
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.code).toBe('OUT_OF_RANGE');
            expect(result.error).toContain(String(STROKE_INDEX_MIN));
            expect(result.error).toContain(String(STROKE_INDEX_MAX));
          }
          // Nothing was previously stored, so it remains unset (null).
          expect(storedStrokeIndex(service, ordinal)).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a duplicate, identifies the conflicting hole, and leaves the stored set unchanged (Requirement 1.4)', () => {
    // Two distinct holes and a valid stroke index to collide on.
    const twoHolesArb = fc
      .tuple(ordinalArb, ordinalArb)
      .filter(([a, b]) => a !== b) as fc.Arbitrary<[HoleOrdinal, HoleOrdinal]>;

    fc.assert(
      fc.property(twoHolesArb, validStrokeIndexArb, ([holeA, holeB], value) => {
        const { service } = freshService();

        // Assign the value to hole A.
        const first = service.setStrokeIndex(holeA, value);
        expect(isOk(first)).toBe(true);
        expect(storedStrokeIndex(service, holeA)).toBe(value);

        const beforeDuplicate = storedStrokeIndices(service);

        // Assigning the same value to a different hole must be rejected as a
        // duplicate, and the conflicting hole (A) must be identified.
        const duplicate = service.setStrokeIndex(holeB, value);
        expect(isErr(duplicate)).toBe(true);
        if (isErr(duplicate)) {
          expect(duplicate.code).toBe('DUPLICATE');
          expect(duplicate.error).toContain(String(holeA));
        }

        // Retain-on-reject: the whole stored set of stroke indices is unchanged.
        expect(storedStrokeIndices(service)).toEqual(beforeDuplicate);
        // Hole B was never assigned.
        expect(storedStrokeIndex(service, holeB)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('retains the previously stored stroke index when a subsequent invalid value is rejected (Requirement 1.5)', () => {
    // A value that is guaranteed out of range: boundary 0 and 19, out-of-range
    // integers, and non-integers/NaN. Never lands in [1, 18].
    const invalidStrokeIndexArb = fc.oneof(
      fc.constantFrom(0, 19),
      fc.integer({ min: STROKE_INDEX_MAX + 1, max: 100 }),
      fc.integer({ min: -100, max: STROKE_INDEX_MIN - 1 }),
      fc.double({ noNaN: false }).filter((n) => !Number.isInteger(n)),
    ) as fc.Arbitrary<StrokeIndex>;

    fc.assert(
      fc.property(
        ordinalArb,
        validStrokeIndexArb,
        invalidStrokeIndexArb,
        (ordinal, good, bad) => {
          const { service } = freshService();

          // First store a known-good value.
          const accepted = service.setStrokeIndex(ordinal, good);
          expect(isOk(accepted)).toBe(true);
          expect(storedStrokeIndex(service, ordinal)).toBe(good);

          const beforeReject = storedStrokeIndices(service);

          // A subsequent invalid entry must be rejected and must not change it.
          const rejected = service.setStrokeIndex(ordinal, bad);
          expect(isErr(rejected)).toBe(true);
          if (isErr(rejected)) {
            expect(rejected.code).toBe('OUT_OF_RANGE');
            expect(rejected.error).toContain(String(STROKE_INDEX_MIN));
            expect(rejected.error).toContain(String(STROKE_INDEX_MAX));
          }

          // Retain-on-reject: the stored set of stroke indices is unchanged.
          expect(storedStrokeIndices(service)).toEqual(beforeReject);
          expect(storedStrokeIndex(service, ordinal)).toBe(good);
        },
      ),
      { numRuns: 100 },
    );
  });
});
