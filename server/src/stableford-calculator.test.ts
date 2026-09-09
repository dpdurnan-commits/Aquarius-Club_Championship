import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HOLE_ORDINALS,
  isOk,
  isErr,
  type HoleOrdinal,
  type StrokeIndex,
} from '@ccs/types';
import type { Par } from '@ccs/types';
import {
  allocateHandicapStrokes,
  stablefordForHole,
  type StrokeIndexByHole,
} from './stableford-calculator.js';

/**
 * Feature: club-championship-scoring
 * Property 7: Handicap stroke allocation is correct and totals the handicap
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 *
 * For any playing handicap H in [0, 36] and any complete permutation of the
 * stroke indices {1..18}: each hole receives one stroke where its stroke index
 * <= H plus a second where its stroke index <= H - 18, no hole receives more
 * than 2 strokes, and the total strokes allocated across the 18 holes equals H
 * (which is 0 when H is 0).
 */
describe('Property 7: Handicap stroke allocation is correct and totals the handicap', () => {
  // Handicap generator over whole numbers 0..36, biased to include the
  // boundary cases 0, 18, and 36 alongside the uniform range.
  const handicapArb = fc.oneof(
    fc.constantFrom(0, 18, 36),
    fc.integer({ min: 0, max: 36 }),
  );

  // A full permutation of the stroke indices {1..18}: shuffle the complete
  // ordered array, constrained to keep every element (a bijection over 1..18).
  const strokeIndexOrderArb = fc.shuffledSubarray(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    { minLength: 18, maxLength: 18 },
  ) as fc.Arbitrary<StrokeIndex[]>;

  it('allocates per-hole strokes that respect the max-2 rule and total the handicap', () => {
    fc.assert(
      fc.property(handicapArb, strokeIndexOrderArb, (handicap, siOrder) => {
        // Assign the permuted stroke indices to the 18 holes in ordinal order.
        const strokeIndexByHole: StrokeIndexByHole = new Map<
          HoleOrdinal,
          StrokeIndex
        >(HOLE_ORDINALS.map((ordinal, i) => [ordinal, siOrder[i]]));

        const result = allocateHandicapStrokes(handicap, strokeIndexByHole);
        // Inputs are always complete here, so allocation must succeed.
        expect(isOk(result)).toBe(true);
        if (!isOk(result)) return false;

        const allocation = result.value;

        let total = 0;
        for (const ordinal of HOLE_ORDINALS) {
          const strokeIndex = strokeIndexByHole.get(ordinal) as StrokeIndex;
          const strokes = allocation.get(ordinal) ?? 0;

          // Expected per-hole allocation straight from the rules. (4.1, 4.2)
          const expectedFirst = strokeIndex <= handicap ? 1 : 0;
          const expectedSecond = strokeIndex <= handicap - 18 ? 1 : 0;
          const expected = expectedFirst + expectedSecond;

          // Per-hole correctness. (4.1, 4.2)
          expect(strokes).toBe(expected);
          // No hole ever receives more than 2 strokes.
          expect(strokes).toBeLessThanOrEqual(2);

          total += strokes;
        }

        // Total allocated across all holes equals H (0 when H = 0). (4.3)
        expect(total).toBe(handicap);

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 8: Allocation requires available inputs
 *
 * Validates: Requirements 4.4
 *
 * For any invocation where the handicap is unavailable (null/undefined) or any
 * one of the 18 hole stroke indices is unavailable (missing/null/undefined),
 * handicap-stroke allocation is withheld and an INPUTS_UNAVAILABLE indication
 * is returned instead of an allocation.
 */
describe('Property 8: Allocation requires available inputs', () => {
  // A complete, valid map of stroke indices for all 18 holes: a shuffled
  // permutation of {1..18} assigned to the holes in ordinal order.
  const completeStrokeIndicesArb = (
    fc.shuffledSubarray(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
      { minLength: 18, maxLength: 18 },
    ) as fc.Arbitrary<StrokeIndex[]>
  ).map(
    (siOrder) =>
      new Map<HoleOrdinal, StrokeIndex | null | undefined>(
        HOLE_ORDINALS.map((ordinal, i) => [ordinal, siOrder[i]]),
      ),
  );

  // A valid, available handicap over the permitted whole-number range.
  const availableHandicapArb = fc.integer({ min: 0, max: 36 });

  it('withholds allocation and returns INPUTS_UNAVAILABLE when the handicap is unavailable', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        completeStrokeIndicesArb,
        (missingHandicap, strokeIndexByHole) => {
          const result = allocateHandicapStrokes(
            missingHandicap,
            strokeIndexByHole,
          );

          // Allocation is withheld: no success value is produced. (4.4)
          expect(isOk(result)).toBe(false);
          // The inputs-unavailable indication is returned. (4.4)
          expect(isErr(result)).toBe(true);
          if (!isErr(result)) return false;
          expect(result.code).toBe('INPUTS_UNAVAILABLE');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('withholds allocation and returns INPUTS_UNAVAILABLE when any hole stroke index is unavailable', () => {
    fc.assert(
      fc.property(
        availableHandicapArb,
        completeStrokeIndicesArb,
        // Which hole ordinal loses its stroke index, and how (missing vs null).
        fc.constantFrom(...HOLE_ORDINALS),
        fc.constantFrom<'delete' | 'null' | 'undefined'>(
          'delete',
          'null',
          'undefined',
        ),
        (handicap, completeStrokeIndices, missingOrdinal, mode) => {
          // Start from a complete map, then knock out exactly one hole so the
          // inputs become unavailable.
          const strokeIndexByHole = new Map<
            HoleOrdinal,
            StrokeIndex | null | undefined
          >(completeStrokeIndices);

          if (mode === 'delete') {
            strokeIndexByHole.delete(missingOrdinal);
          } else if (mode === 'null') {
            strokeIndexByHole.set(missingOrdinal, null);
          } else {
            strokeIndexByHole.set(missingOrdinal, undefined);
          }

          const result = allocateHandicapStrokes(handicap, strokeIndexByHole);

          // Allocation is withheld: no success value is produced. (4.4)
          expect(isOk(result)).toBe(false);
          // The inputs-unavailable indication is returned. (4.4)
          expect(isErr(result)).toBe(true);
          if (!isErr(result)) return false;
          expect(result.code).toBe('INPUTS_UNAVAILABLE');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 9: Stableford points mapping
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 *
 * For any recorded numeric gross, par, and handicap strokes on the hole, the
 * points equal the mapping of `diff = (gross - handicapStrokes) - par`:
 * 5 when diff <= -3, 4 at -2, 3 at -1, 2 at 0, 1 at +1, and 0 when diff >= +2.
 */
describe('Property 9: Stableford points mapping', () => {
  // Par for a hole is an integer 3..6. (types Par)
  const parArb = fc.constantFrom<Par>(3, 4, 5, 6);

  // Handicap strokes allocated to a single hole are 0, 1, or 2.
  const handicapStrokesArb = fc.integer({ min: 0, max: 2 });

  // A recorded numeric gross is an integer of 1 or greater (5.8). The upper
  // bound comfortably exercises every diff branch, including diff <= -3 and
  // diff >= +2, across the whole par/handicap-stroke space.
  const grossArb = fc.integer({ min: 1, max: 20 });

  // The specification's mapping, expressed directly from diff. (5.2–5.7)
  const expectedPoints = (diff: number): number => {
    if (diff <= -3) return 5; // (5.2)
    if (diff === -2) return 4; // (5.3)
    if (diff === -1) return 3; // (5.4)
    if (diff === 0) return 2; // (5.5)
    if (diff === 1) return 1; // (5.6)
    return 0; // diff >= +2 (5.7)
  };

  it('maps a recorded numeric gross to the correct Stableford points via diff', () => {
    fc.assert(
      fc.property(
        grossArb,
        parArb,
        handicapStrokesArb,
        (gross, par, handicapStrokesOnHole) => {
          const result = stablefordForHole(gross, par, handicapStrokesOnHole);

          // A recorded, valid numeric gross always produces points. (5.1–5.7)
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return false;

          // diff = (gross - handicapStrokes) - par. (5.1)
          const diff = gross - handicapStrokesOnHole - par;
          expect(result.value).toBe(expectedPoints(diff));

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 10: Points are monotonically non-increasing in gross
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 *
 * For any hole configuration and any two gross values a <= b, the Stableford
 * points for a are greater than or equal to the points for b (taking more
 * strokes never earns more points).
 */
describe('Property 10: Points are monotonically non-increasing in gross', () => {
  // Par for a hole is an integer 3..6. (types Par)
  const parArb = fc.constantFrom<Par>(3, 4, 5, 6);

  // Handicap strokes allocated to a single hole are 0, 1, or 2.
  const handicapStrokesArb = fc.integer({ min: 0, max: 2 });

  // Two valid gross values (integers >= 1). We order them so that
  // `lower <= higher` regardless of how the generator produced them; the
  // range comfortably spans every diff branch for any par/handicap-stroke.
  const grossArb = fc.integer({ min: 1, max: 20 });

  it('never awards more points for a higher gross than for a lower gross', () => {
    fc.assert(
      fc.property(
        parArb,
        handicapStrokesArb,
        grossArb,
        grossArb,
        (par, handicapStrokesOnHole, g1, g2) => {
          const lower = Math.min(g1, g2);
          const higher = Math.max(g1, g2);

          const lowerResult = stablefordForHole(
            lower,
            par,
            handicapStrokesOnHole,
          );
          const higherResult = stablefordForHole(
            higher,
            par,
            handicapStrokesOnHole,
          );

          // Both gross values are valid, so both produce points. (5.1–5.7)
          expect(isOk(lowerResult)).toBe(true);
          expect(isOk(higherResult)).toBe(true);
          if (!isOk(lowerResult) || !isOk(higherResult)) return false;

          // Monotonicity: fewer strokes never earns fewer points. (5.2–5.7)
          expect(lowerResult.value).toBeGreaterThanOrEqual(higherResult.value);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 11: Invalid gross yields no computation
 *
 * Validates: Requirements 5.8
 *
 * For any raw gross value that is non-integer or less than 1, the Stableford
 * Calculator rejects the value: it returns an INVALID indication and computes
 * no net strokes or points for that hole (no success value is produced).
 */
describe('Property 11: Invalid gross yields no computation', () => {
  // Par for a hole is an integer 3..6. (types Par)
  const parArb = fc.constantFrom<Par>(3, 4, 5, 6);

  // Handicap strokes allocated to a single hole are 0, 1, or 2.
  const handicapStrokesArb = fc.integer({ min: 0, max: 2 });

  // Invalid raw gross values, covering every rejected shape from 5.8:
  //  - non-integer finite numbers (e.g. 2.5, -0.1),
  //  - integers less than 1 (zero and negatives),
  //  - non-numeric doubles NaN and infinities (neither integer nor >= 1).
  const nonIntegerArb = fc
    .double({ min: -1000, max: 1000, noNaN: true })
    .filter((n) => !Number.isInteger(n));
  const belowOneIntegerArb = fc.integer({ min: -1000, max: 0 });
  const nonNumericDoubleArb = fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  const invalidGrossArb = fc.oneof(
    nonIntegerArb,
    belowOneIntegerArb,
    nonNumericDoubleArb,
  );

  it('rejects invalid gross with an INVALID indication and computes no net or points', () => {
    fc.assert(
      fc.property(
        invalidGrossArb,
        parArb,
        handicapStrokesArb,
        (invalidGross, par, handicapStrokesOnHole) => {
          const result = stablefordForHole(
            invalidGross,
            par,
            handicapStrokesOnHole,
          );

          // No net/points are computed: no success value is produced. (5.8)
          expect(isOk(result)).toBe(false);
          // The invalid-value indication is returned. (5.8)
          expect(isErr(result)).toBe(true);
          if (!isErr(result)) return false;
          expect(result.code).toBe('INVALID');
          // No computed value leaks through the error branch. (5.8)
          expect('value' in result).toBe(false);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
