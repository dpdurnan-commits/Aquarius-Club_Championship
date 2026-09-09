import { describe, it, expect } from 'vitest';
import {
  HOLE_ORDINALS,
  isOk,
  type HoleOrdinal,
  type Par,
  type StrokeIndex,
} from '@ccs/types';
import {
  allocateHandicapStrokes,
  netStrokes,
  stablefordForHole,
  type StrokeIndexByHole,
} from './stableford-calculator.js';

/**
 * Feature: club-championship-scoring
 * Concrete unit tests — boundary handicaps and a worked Stableford scorecard.
 *
 * These are example-based regression anchors (not property-based). They pin
 * down the exact allocation at the handicap boundaries and one fully worked
 * scorecard so future refactors cannot silently drift.
 *
 * Requirements covered:
 *  - 4.3: WHEN the Playing_Handicap is 0, allocate zero Handicap_Strokes_On_Hole
 *         to every hole. (Plus H=18 and H=36 boundary allocation anchors.)
 *  - 5.1: Compute Net_Strokes as Gross_Strokes minus Handicap_Strokes_On_Hole.
 *  - 5.5: WHEN Net_Strokes equals Par, assign 2 Stableford_Points.
 */

/**
 * A canonical, complete stroke-index map: hole ordinal N carries stroke index N
 * (a valid bijection over 1..18). This makes the boundary maths easy to read:
 * "stroke index <= H" is simply "ordinal <= H".
 */
function identityStrokeIndexByHole(): StrokeIndexByHole {
  return new Map<HoleOrdinal, StrokeIndex>(
    HOLE_ORDINALS.map((ordinal) => [ordinal, ordinal as unknown as StrokeIndex]),
  );
}

function totalStrokes(allocation: ReadonlyMap<HoleOrdinal, number>): number {
  let total = 0;
  for (const ordinal of HOLE_ORDINALS) {
    total += allocation.get(ordinal) ?? 0;
  }
  return total;
}

describe('Boundary handicap allocation (Requirement 4.3)', () => {
  const strokeIndexByHole = identityStrokeIndexByHole();

  it('H=0 allocates zero strokes to every hole', () => {
    const result = allocateHandicapStrokes(0, strokeIndexByHole);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    for (const ordinal of HOLE_ORDINALS) {
      expect(result.value.get(ordinal)).toBe(0);
    }
    expect(totalStrokes(result.value)).toBe(0);
  });

  it('H=18 allocates exactly one stroke to every hole (total 18)', () => {
    const result = allocateHandicapStrokes(18, strokeIndexByHole);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    for (const ordinal of HOLE_ORDINALS) {
      expect(result.value.get(ordinal)).toBe(1);
    }
    expect(totalStrokes(result.value)).toBe(18);
  });

  it('H=36 allocates exactly two strokes to every hole (total 36)', () => {
    const result = allocateHandicapStrokes(36, strokeIndexByHole);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    for (const ordinal of HOLE_ORDINALS) {
      expect(result.value.get(ordinal)).toBe(2);
    }
    expect(totalStrokes(result.value)).toBe(36);
  });

  it('intermediate H=20 gives one stroke on holes SI 1..18 and a second on SI 1..2 (total 20)', () => {
    const result = allocateHandicapStrokes(20, strokeIndexByHole);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // With the identity map, ordinal === stroke index.
    // First stroke: SI <= 20 → every hole (SI 1..18). Second stroke: SI <= 2.
    for (const ordinal of HOLE_ORDINALS) {
      const expected = ordinal <= 2 ? 2 : 1;
      expect(result.value.get(ordinal)).toBe(expected);
    }
    expect(totalStrokes(result.value)).toBe(20);
  });

  it('intermediate H=7 gives one stroke only on holes SI 1..7 (total 7)', () => {
    const result = allocateHandicapStrokes(7, strokeIndexByHole);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    for (const ordinal of HOLE_ORDINALS) {
      const expected = ordinal <= 7 ? 1 : 0;
      expect(result.value.get(ordinal)).toBe(expected);
    }
    expect(totalStrokes(result.value)).toBe(7);
  });
});

describe('Net strokes and par-equals-2-points mapping (Requirements 5.1, 5.5)', () => {
  it('computes net strokes as gross minus handicap strokes on the hole (5.1)', () => {
    expect(netStrokes(5, 0)).toBe(5);
    expect(netStrokes(5, 1)).toBe(4);
    expect(netStrokes(6, 2)).toBe(4);
  });

  it('awards exactly 2 points when net strokes equal par (5.5)', () => {
    // Gross 4, no handicap stroke, par 4 → net 4 = par → 2 points.
    const noStroke = stablefordForHole(4, 4 as Par, 0);
    expect(isOk(noStroke)).toBe(true);
    if (isOk(noStroke)) expect(noStroke.value).toBe(2);

    // Gross 5, one handicap stroke, par 4 → net 4 = par → 2 points.
    const oneStroke = stablefordForHole(5, 4 as Par, 1);
    expect(isOk(oneStroke)).toBe(true);
    if (isOk(oneStroke)) expect(oneStroke.value).toBe(2);

    // Gross 6, two handicap strokes, par 4 → net 4 = par → 2 points.
    const twoStrokes = stablefordForHole(6, 4 as Par, 2);
    expect(isOk(twoStrokes)).toBe(true);
    if (isOk(twoStrokes)) expect(twoStrokes.value).toBe(2);
  });
});

/**
 * Worked scorecard regression anchor.
 *
 * A player off Playing_Handicap 9 on a course whose front nine has stroke
 * indices arranged so exactly holes with SI 1..9 receive a stroke. We compute
 * points hole-by-hole and assert the exact per-hole points and the round total,
 * exercising net strokes (5.1) and the full points mapping including the
 * par-equals-2-points case (5.5).
 */
describe('Worked scorecard — H=9, known gross → known Stableford points', () => {
  // Nine-hole worked example. par / strokeIndex / gross chosen to hit a spread
  // of point outcomes; strokeIndex <= 9 means the hole gets one handicap stroke.
  const holes: ReadonlyArray<{
    par: Par;
    strokeIndex: StrokeIndex;
    gross: number;
    expectedPoints: number;
  }> = [
    // SI 1 → 1 stroke. gross 5, par 4 → net 4 = par → 2. (5.5)
    { par: 4, strokeIndex: 1, gross: 5, expectedPoints: 2 },
    // SI 2 → 1 stroke. gross 4, par 4 → net 3 = birdie (-1) → 3.
    { par: 4, strokeIndex: 2, gross: 4, expectedPoints: 3 },
    // SI 3 → 1 stroke. gross 6, par 5 → net 5 = par → 2. (5.5)
    { par: 5, strokeIndex: 3, gross: 6, expectedPoints: 2 },
    // SI 4 → 1 stroke. gross 3, par 3 → net 2 = birdie (-1) → 3.
    { par: 3, strokeIndex: 4, gross: 3, expectedPoints: 3 },
    // SI 5 → 1 stroke. gross 7, par 4 → net 6 = +2 → 0. (5.7)
    { par: 4, strokeIndex: 5, gross: 7, expectedPoints: 0 },
    // SI 6 → 1 stroke. gross 5, par 5 → net 4 = birdie (-1) → 3.
    { par: 5, strokeIndex: 6, gross: 5, expectedPoints: 3 },
    // SI 10 → 0 strokes (10 > 9). gross 4, par 4 → net 4 = par → 2. (5.5)
    { par: 4, strokeIndex: 10, gross: 4, expectedPoints: 2 },
    // SI 11 → 0 strokes. gross 6, par 4 → net 6 = +2 → 0. (5.7)
    { par: 4, strokeIndex: 11, gross: 6, expectedPoints: 0 },
    // SI 12 → 0 strokes. gross 4, par 3 → net 4 = +1 bogey → 1. (5.6)
    { par: 3, strokeIndex: 12, gross: 4, expectedPoints: 1 },
  ];

  it('produces the exact expected points per hole and the correct total', () => {
    // Build the stroke-index map for the holes under test, then allocate.
    const strokeIndexByHole = new Map<HoleOrdinal, StrokeIndex>(
      holes.map((hole, i) => [
        HOLE_ORDINALS[i],
        hole.strokeIndex,
      ]),
    );
    // Fill the remaining holes so allocation has a complete, valid input set.
    const usedStrokeIndices = new Set(holes.map((h) => h.strokeIndex));
    let filler: StrokeIndex = 1;
    for (let i = holes.length; i < HOLE_ORDINALS.length; i += 1) {
      while (usedStrokeIndices.has(filler)) {
        filler = (filler + 1) as StrokeIndex;
      }
      usedStrokeIndices.add(filler);
      strokeIndexByHole.set(HOLE_ORDINALS[i], filler);
    }

    const allocationResult = allocateHandicapStrokes(9, strokeIndexByHole);
    expect(isOk(allocationResult)).toBe(true);
    if (!isOk(allocationResult)) return;
    const allocation = allocationResult.value;

    let total = 0;
    holes.forEach((hole, i) => {
      const ordinal = HOLE_ORDINALS[i];
      const strokesOnHole = allocation.get(ordinal) ?? 0;

      // Sanity check the allocation matches the SI <= 9 rule for this hole.
      expect(strokesOnHole).toBe(hole.strokeIndex <= 9 ? 1 : 0);

      const points = stablefordForHole(hole.gross, hole.par, strokesOnHole);
      expect(isOk(points)).toBe(true);
      if (!isOk(points)) return;
      expect(points.value).toBe(hole.expectedPoints);
      total += points.value;
    });

    // 2 + 3 + 2 + 3 + 0 + 3 + 2 + 0 + 1 = 16.
    expect(total).toBe(16);
  });
});
