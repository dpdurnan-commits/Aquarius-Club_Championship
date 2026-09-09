import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HOLE_ORDINALS,
  PAR_MAX,
  PAR_MIN,
  STROKE_INDEX_MAX,
  STROKE_INDEX_MIN,
  isErr,
  isOk,
  type Hole,
  type HoleOrdinal,
  type Par,
  type StrokeIndex,
} from '@ccs/types';
import type { Repository } from './repository.js';
import { CourseSetupService } from './course-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Property 3: Course completeness predicate
 *
 * Validates: Requirements 1.8, 1.9
 *
 * For any course state, the configuration is treated as COMPLETE if and only if
 * all 18 pars are integers in [3, 6] AND the 18 stroke indices are exactly a
 * permutation of {1..18} (1.8). Whenever the state is not complete, the
 * configuration is WITHHELD from the Stableford calculator with an
 * incomplete-configuration indication (1.9).
 *
 * The completeness predicate reads course state through `Repository.getHoles()`.
 * To exercise the full biconditional — including incompleteness modes the SQLite
 * schema's CHECK/UNIQUE constraints would otherwise prevent from ever being
 * stored (out-of-range pars, duplicate stroke indices) — this test drives the
 * real `CourseSetupService` over a tiny in-memory holes source that returns the
 * arbitrary 18-hole state under test. The predicate under test is unchanged; the
 * source only supplies the domain states it must classify.
 */
describe('Property 3: Course completeness predicate', () => {
  /**
   * A real CourseSetupService whose only persistence dependency, `getHoles()`,
   * returns the supplied 18-hole state. This lets a property generate any course
   * state (valid, out-of-range, duplicate, or omitted) and check the predicate.
   */
  const serviceOver = (holes: readonly Hole[]): CourseSetupService => {
    const source = { getHoles: () => holes.map((h) => ({ ...h })) };
    return new CourseSetupService(source as unknown as Repository);
  };

  /** The 18 hole ordinals, 1..18, in ascending order. */
  const ordinals = HOLE_ORDINALS;

  /** Reference oracle for the completeness predicate, straight from Req 1.8. */
  const oracleComplete = (holes: readonly Hole[]): boolean => {
    if (holes.length !== 18) {
      return false;
    }
    const parsValid = holes.every(
      (h) =>
        typeof h.par === 'number' &&
        Number.isInteger(h.par) &&
        h.par >= PAR_MIN &&
        h.par <= PAR_MAX,
    );
    if (!parsValid) {
      return false;
    }
    const indices = holes.map((h) => h.strokeIndex);
    if (indices.some((si) => si === null || si === undefined)) {
      return false;
    }
    const distinct = new Set(indices);
    if (distinct.size !== 18) {
      return false;
    }
    for (let v = STROKE_INDEX_MIN; v <= STROKE_INDEX_MAX; v += 1) {
      if (!distinct.has(v as StrokeIndex)) {
        return false;
      }
    }
    return true;
  };

  /** A par cell: a valid par, a null (unset), or an out-of-range integer. */
  const parCellArb = fc.oneof(
    fc.integer({ min: PAR_MIN, max: PAR_MAX }), // valid: 3..6
    fc.constant(null), // omitted
    fc.constantFrom(0, 1, 2, 7, 8, 10), // out of range
  ) as fc.Arbitrary<Par | null>;

  /** A stroke-index cell: an in-range value or a null (unset). */
  const strokeCellArb = fc.oneof(
    fc.integer({ min: STROKE_INDEX_MIN, max: STROKE_INDEX_MAX }),
    fc.constant(null),
  ) as fc.Arbitrary<StrokeIndex | null>;

  /**
   * An arbitrary 18-hole course state. Pars and stroke indices are drawn
   * independently per hole, so this freely produces missing pars, out-of-range
   * pars, missing stroke indices, duplicate stroke indices, and omissions —
   * plus, occasionally, a fully valid configuration.
   */
  const arbitraryCourseArb: fc.Arbitrary<Hole[]> = fc
    .tuple(
      fc.array(parCellArb, { minLength: 18, maxLength: 18 }),
      fc.array(strokeCellArb, { minLength: 18, maxLength: 18 }),
    )
    .map(([pars, indices]) =>
      ordinals.map((ordinal, i) => ({
        ordinal: ordinal as HoleOrdinal,
        par: pars[i] ?? null,
        strokeIndex: indices[i] ?? null,
      })),
    );

  /** A guaranteed-complete course: all pars valid and a shuffled 1..18 permutation. */
  const completeCourseArb: fc.Arbitrary<Hole[]> = fc
    .tuple(
      fc.array(fc.integer({ min: PAR_MIN, max: PAR_MAX }), {
        minLength: 18,
        maxLength: 18,
      }),
      fc.shuffledSubarray([...ordinals], { minLength: 18, maxLength: 18 }),
    )
    .map(([pars, permutation]) =>
      ordinals.map((ordinal, i) => ({
        ordinal: ordinal as HoleOrdinal,
        par: pars[i] as Par,
        strokeIndex: permutation[i] as unknown as StrokeIndex,
      })),
    );

  it('is complete iff all pars are in [3,6] and stroke indices are a permutation of {1..18} (Requirement 1.8)', () => {
    fc.assert(
      fc.property(arbitraryCourseArb, (holes) => {
        const service = serviceOver(holes);
        // The predicate must agree with the oracle on every generated state,
        // covering missing/out-of-range pars, missing/duplicate/omitted indices,
        // and the occasional fully valid course — both directions of the iff.
        expect(service.isCourseComplete()).toBe(oracleComplete(holes));
      }),
      { numRuns: 100 },
    );
  });

  it('recognises every fully valid configuration as complete (Requirement 1.8)', () => {
    fc.assert(
      fc.property(completeCourseArb, (holes) => {
        const service = serviceOver(holes);
        expect(service.isCourseComplete()).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('withholds the configuration with an incomplete indication exactly when not complete, and releases it when complete (Requirement 1.9)', () => {
    fc.assert(
      fc.property(arbitraryCourseArb, (holes) => {
        const service = serviceOver(holes);
        const complete = oracleComplete(holes);
        const config = service.getConfigForCalculator();

        if (complete) {
          // Released: the calculator gets a full config for all 18 holes.
          expect(isOk(config)).toBe(true);
          if (isOk(config)) {
            expect(config.value.parByHole.size).toBe(18);
            expect(config.value.strokeIndexByHole.size).toBe(18);
          }
        } else {
          // Withheld: an incomplete-configuration indication instead of a config.
          expect(isErr(config)).toBe(true);
          if (isErr(config)) {
            expect(config.code).toBe('INCOMPLETE_CONFIGURATION');
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
