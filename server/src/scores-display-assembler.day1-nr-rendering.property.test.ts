import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HOLE_ORDINALS,
  PAR_MIN,
  PAR_MAX,
  GROSS_MIN,
  GROSS_MAX,
  type Day,
  type Gross,
  type Hole,
  type Par,
  type Player,
  type Score,
  type StrokeIndex,
} from '@ccs/types';
import type { Repository } from './repository.js';
import { ScoresDisplayAssembler } from './scores-display-assembler.js';
import {
  allocateHandicapStrokes,
  stablefordForHole,
} from './stableford-calculator.js';

/**
 * Feature: club-championship-scoring
 * Property 26: Day 1 NR rendering
 *
 * Validates: Requirements 8.12, 8.13, 8.14, 8.15
 *
 * For any Day 1 card for a player that contains at least one NR hole:
 *  - the aggregate-strokes cell renders "NR (NR)" (numeric total suppressed,
 *    position "NR") (8.12);
 *  - the aggregate-Stableford cell shows the numeric-holes points total with its
 *    bracketed position rendered "NR" (8.13);
 *  - the relative-to-par cell renders "NR" (8.14);
 *  - the aggregate-Stableford total equals the sum of Stableford points over the
 *    Day 1 holes that have a numeric gross recorded (NR / unrecorded holes
 *    contribute nothing) (8.15).
 *
 * This drives the real `ScoresDisplayAssembler.buildDay1View` over a tiny
 * in-memory repository stub exposing only the three read methods `buildDay1View`
 * uses (`getHoles`, `getPlayers`, `getScoresForDay`). Day 2 scores are never
 * requested, so `getScoresForDay(2)` returns an empty list. A fully configured
 * course (valid pars, a permuted 1..18 stroke-index set) plus a whole-number
 * handicap is used so per-hole points are well defined. Each generated card is
 * forced to contain at least one NR hole — exactly the precondition of the
 * property.
 *
 * The expected aggregate-Stableford total (8.15) is recomputed here with the
 * same domain logic (`allocateHandicapStrokes` + `stablefordForHole`) the
 * assembler reuses, summed over only the numeric holes, rather than re-deriving
 * the Stableford rules by hand.
 */
describe('Property 26: Day 1 NR rendering', () => {
  /**
   * An assembler whose only persistence dependency is the three read methods
   * `buildDay1View` calls. Rows are deep-copied so the assembler cannot mutate
   * the generated fixtures.
   */
  const assemblerOver = (
    holes: readonly Hole[],
    players: readonly Player[],
    day1Scores: readonly Score[],
  ): ScoresDisplayAssembler => {
    const source = {
      getHoles: () => holes.map((h) => ({ ...h })),
      getPlayers: () => players.map((p) => ({ ...p })),
      getScoresForDay: (day: Day) =>
        (day === 1 ? day1Scores : []).map((s) => ({ ...s })),
    };
    return new ScoresDisplayAssembler(source as unknown as Repository);
  };

  /** A guaranteed-complete course: valid pars and a shuffled 1..18 permutation. */
  const courseArb: fc.Arbitrary<Hole[]> = fc
    .tuple(
      fc.array(fc.integer({ min: PAR_MIN, max: PAR_MAX }), {
        minLength: 18,
        maxLength: 18,
      }),
      fc.shuffledSubarray([...HOLE_ORDINALS], { minLength: 18, maxLength: 18 }),
    )
    .map(([pars, permutation]) =>
      HOLE_ORDINALS.map((ordinal, i) => ({
        ordinal,
        par: pars[i] as Par,
        strokeIndex: permutation[i] as unknown as StrokeIndex,
      })),
    );

  /**
   * A single Day 1 hole cell for a player, covering all three states:
   *  - numeric: a recorded gross in [1,20];
   *  - NR: no return;
   *  - unrecorded: no score at all.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ kind: 'numeric' as const, gross: gross as Gross })),
    fc.constant({ kind: 'NR' as const }),
    fc.constant({ kind: 'unrecorded' as const }),
  );

  /**
   * A player's full 18-hole Day 1 card with AT LEAST ONE NR hole: 18 arbitrary
   * cells plus an index forced to NR, guaranteeing the player has a Day 1 NR —
   * the precondition of Property 26.
   */
  const cardArb = fc
    .tuple(
      fc.array(cellArb, { minLength: 18, maxLength: 18 }),
      fc.integer({ min: 0, max: 17 }),
    )
    .map(([cells, forcedNRIndex]) => {
      const card = [...cells];
      card[forcedNRIndex] = { kind: 'NR' as const };
      return card;
    });

  /** A whole-number Day 1 playing handicap in [0, 36]. */
  const handicapArb = fc.integer({ min: 0, max: 36 });

  it('renders "NR (NR)" strokes, "NR" Stableford position over the numeric-holes total, and "NR" relative-to-par when the player has any Day 1 NR (Requirements 8.12, 8.13, 8.14, 8.15)', () => {
    fc.assert(
      fc.property(courseArb, cardArb, handicapArb, (holes, card, handicap) => {
        const player: Player = {
          id: 'p1',
          name: 'Player One',
          handicapDay1: handicap,
          handicapDay2: handicap,
          cut: false,
        };

        const scores: Score[] = [];
        HOLE_ORDINALS.forEach((ordinal, i) => {
          const cell = card[i];
          if (cell.kind === 'numeric') {
            scores.push({
              playerId: player.id,
              day: 1,
              ordinal,
              gross: cell.gross,
              noReturn: false,
            });
          } else if (cell.kind === 'NR') {
            scores.push({
              playerId: player.id,
              day: 1,
              ordinal,
              gross: null,
              noReturn: true,
            });
          }
          // 'unrecorded' contributes no score row at all.
        });

        // Recompute the per-hole handicap allocation with the same domain logic
        // the assembler reuses, so the expected Stableford total is not
        // re-derived by hand.
        const strokeIndexByHole = new Map(
          holes.map((h) => [h.ordinal, h.strokeIndex]),
        );
        const allocation = allocateHandicapStrokes(handicap, strokeIndexByHole);
        expect(allocation.ok).toBe(true);
        const parByOrdinal = new Map<number, Par>(
          holes.map((h) => [h.ordinal, h.par]),
        );

        // 8.15: expected aggregate Stableford is the sum of points over exactly
        // the numeric holes; NR and unrecorded holes contribute nothing.
        let expectedStableford = 0;
        HOLE_ORDINALS.forEach((ordinal, i) => {
          const cell = card[i];
          if (cell.kind !== 'numeric') return;
          const par = parByOrdinal.get(ordinal) as Par;
          const strokesOnHole = allocation.ok
            ? (allocation.value.get(ordinal) ?? 0)
            : 0;
          const points = stablefordForHole(
            { kind: 'numeric', gross: cell.gross },
            par,
            strokesOnHole,
          );
          if (points.ok) {
            expectedStableford += points.value;
          }
        });

        const view = assemblerOver(holes, [player], scores).buildDay1View();
        const row = view.rows.find((r) => r.playerId === player.id);
        expect(row).toBeDefined();
        if (!row) return;

        // 8.12: aggregate-strokes cell renders "NR (NR)" with the numeric total
        // suppressed and no position.
        expect(row.aggregateStrokes.isNR).toBe(true);
        expect(row.aggregateStrokes.position).toBeNull();
        expect(row.aggregateStrokes.text).toBe('NR (NR)');

        // 8.13 + 8.15: aggregate-Stableford cell shows the numeric-holes points
        // total with the bracketed position rendered "NR".
        expect(row.aggregateStableford.isNR).toBe(true);
        expect(row.aggregateStableford.position).toBeNull();
        expect(row.aggregateStableford.total).toBe(expectedStableford);
        expect(row.aggregateStableford.text).toBe(`${expectedStableford} (NR)`);

        // 8.14: relative-to-par cell renders "NR" instead of a signed value.
        expect(row.relativeToPar.isNR).toBe(true);
        expect(row.relativeToPar.value).toBeNull();
        expect(row.relativeToPar.text).toBe('NR');
      }),
      { numRuns: 100 },
    );
  });
});
