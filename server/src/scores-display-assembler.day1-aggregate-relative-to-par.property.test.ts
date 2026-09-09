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
  type HoleOrdinal,
  type Par,
  type Player,
  type Score,
  type StrokeIndex,
} from '@ccs/types';
import type { Repository } from './repository.js';
import { ScoresDisplayAssembler } from './scores-display-assembler.js';

/**
 * Feature: club-championship-scoring
 * Property 23: Aggregate strokes and relative-to-par over completed holes
 *
 * Validates: Requirements 8.5, 8.9, 8.10
 *
 * For any day's scores for a player with no NR that day, the Day 1 aggregate
 * strokes equal the sum of gross over holes with a numeric value (8.5), and the
 * relative-to-par equals that aggregate minus the total par of those same
 * completed holes, rendered signed ("+n", "-n", or "0") (8.9); with no completed
 * holes the aggregate strokes and aggregate Stableford render 0 and the
 * relative-to-par cell renders empty (8.10).
 *
 * This drives the real `ScoresDisplayAssembler.buildDay1View` over a tiny
 * in-memory repository stub that returns the arbitrary course + roster + Day 1
 * scores under test. Only the three read methods `buildDay1View` uses
 * (`getHoles`, `getPlayers`, `getScoresForDay`) are supplied. Scores are
 * generated numeric-only (or omitted), so no player ever has an NR that day —
 * exactly the precondition of the property. A fully configured course (valid
 * pars, permuted stroke indices) is used so per-hole points can be computed and
 * the relative-to-par comparison against par is well defined.
 */
describe('Property 23: Aggregate strokes and relative-to-par over completed holes', () => {
  /**
   * An assembler whose only persistence dependency is the three read methods
   * `buildDay1View` calls. Day 2 scores are never requested by `buildDay1View`,
   * so `getScoresForDay(2)` returns an empty list.
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

  /** Format a relative-to-par value the way Requirement 8.9 specifies. */
  const formatSigned = (value: number): string => {
    if (value > 0) return `+${value}`;
    if (value < 0) return String(value);
    return '0';
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
   * A single hole cell for a player: either a numeric gross in [1,20]
   * (a completed hole) or omitted (unrecorded). Never NR — the property
   * concerns a player with no NR that day.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ recorded: true as const, gross: gross as Gross })),
    fc.constant({ recorded: false as const }),
  );

  /** A player's full 18-hole Day 1 card: one cell per ordinal, numeric or omitted. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  it('renders aggregate strokes as the sum of gross over completed holes and relative-to-par as signed aggregate-minus-par (Requirements 8.5, 8.9)', () => {
    fc.assert(
      fc.property(courseArb, cardArb, (holes, card) => {
        const parByOrdinal = new Map<HoleOrdinal, number>(
          holes.map((h) => [h.ordinal, h.par as number]),
        );

        const player: Player = {
          id: 'p1',
          name: 'Player One',
          handicapDay1: 12,
          handicapDay2: 12,
          cut: false,
        };

        const scores: Score[] = [];
        let expectedStrokes = 0;
        let expectedPar = 0;
        let completedCount = 0;
        HOLE_ORDINALS.forEach((ordinal, i) => {
          const cell = card[i];
          if (cell.recorded) {
            scores.push({
              playerId: player.id,
              day: 1,
              ordinal,
              gross: cell.gross,
              noReturn: false,
            });
            expectedStrokes += cell.gross;
            expectedPar += parByOrdinal.get(ordinal) ?? 0;
            completedCount += 1;
          }
        });

        const view = assemblerOver(holes, [player], scores).buildDay1View();
        const row = view.rows.find((r) => r.playerId === player.id);
        expect(row).toBeDefined();
        if (!row) return;

        // 8.5: aggregate strokes equals the sum of gross over completed holes.
        expect(row.aggregateStrokes.total).toBe(expectedStrokes);
        expect(row.aggregateStrokes.isNR).toBe(false);

        const expectedRelative = expectedStrokes - expectedPar;

        if (completedCount > 0) {
          // 8.9: relative-to-par equals aggregate strokes minus total par of the
          // completed holes, rendered signed "+n"/"-n"/"0".
          expect(row.relativeToPar.value).toBe(expectedRelative);
          expect(row.relativeToPar.text).toBe(formatSigned(expectedRelative));
          expect(row.relativeToPar.isNR).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('renders 0 aggregate strokes, 0 aggregate Stableford, and an empty relative-to-par when there are no completed holes (Requirement 8.10)', () => {
    fc.assert(
      fc.property(courseArb, (holes) => {
        const player: Player = {
          id: 'p1',
          name: 'Player One',
          handicapDay1: 12,
          handicapDay2: 12,
          cut: false,
        };

        // No Day 1 scores at all: the player has zero completed holes and no NR.
        const view = assemblerOver(holes, [player], []).buildDay1View();
        const row = view.rows.find((r) => r.playerId === player.id);
        expect(row).toBeDefined();
        if (!row) return;

        expect(row.aggregateStrokes.total).toBe(0);
        expect(row.aggregateStableford.total).toBe(0);
        expect(row.relativeToPar.text).toBe('');
        expect(row.relativeToPar.value).toBeNull();
        expect(row.relativeToPar.isNR).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
