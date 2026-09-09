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
import {
  allocateHandicapStrokes,
  stablefordForHole,
} from './stableford-calculator.js';

/**
 * Feature: club-championship-scoring
 * Property 29: Day 2 combined cells and cumulative relative-to-par
 *
 * Validates: Requirements 9.5, 9.8, 9.9, 9.10, 9.16
 *
 * For any Player without CUT status and without any No_Return on either day,
 * `ScoresDisplayAssembler.buildDay2View` produces the Day 2 row's combined
 * cells as:
 *  - the Day 1 Aggregate_Strokes column value (9.5);
 *  - a combined strokes cell "day1total (day2total)" over each day's completed
 *    (numeric) holes (9.8);
 *  - a combined Stableford cell "total36 (day2total)" where total36 sums
 *    Stableford points over holes with a numeric gross across BOTH days and
 *    day2total is the Day 2 aggregate Stableford (9.9, 9.16);
 *  - a cumulative relative-to-par equal to the combined Day 1 + Day 2 aggregate
 *    strokes minus the total par of only the completed Day 1 and Day 2 holes,
 *    rendered signed as "+n" / "-n" / "0" (9.10).
 *
 * This drives the real assembler over a tiny in-memory repository stub exposing
 * only the three read methods `buildDay2View` uses (`getHoles`, `getPlayers`,
 * `getScoresForDay`), with rows deep-copied so the assembler cannot mutate the
 * generated fixtures. Cards are generated numeric-or-unrecorded only (never NR):
 * the per-side NR-substitution combinations are covered separately by Property
 * 30, so this test stays inside Property 29's scope where every derived value
 * is a well-defined numeric with no NR substitution.
 *
 * A fully configured course (valid pars, a permuted 1..18 stroke-index set)
 * plus whole-number Day 1 and Day 2 handicaps make per-hole points well defined.
 * Expected totals are recomputed here with the same domain logic the assembler
 * reuses (`allocateHandicapStrokes` + `stablefordForHole`) rather than
 * re-deriving the Stableford tier rules by hand.
 */
describe('Property 29: Day 2 combined cells and cumulative relative-to-par', () => {
  /**
   * An assembler whose only persistence dependency is the three read methods
   * `buildDay2View` calls. Rows are deep-copied so the assembler cannot mutate
   * the generated fixtures.
   */
  const assemblerOver = (
    holes: readonly Hole[],
    players: readonly Player[],
    day1Scores: readonly Score[],
    day2Scores: readonly Score[],
  ): ScoresDisplayAssembler => {
    const source = {
      getHoles: () => holes.map((h) => ({ ...h })),
      getPlayers: () => players.map((p) => ({ ...p })),
      getScoresForDay: (day: Day) =>
        (day === 1 ? day1Scores : day === 2 ? day2Scores : []).map((s) => ({
          ...s,
        })),
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
   * One hole of a player's day card: either a numeric gross (a completed hole)
   * or omitted (unrecorded). Never NR — Property 29 concerns the no-NR case
   * where every combined value is a well-defined numeric.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ recorded: true as const, gross: gross as Gross })),
    fc.constant({ recorded: false as const }),
  );

  /** A full 18-hole card: one cell per ordinal. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  /** A whole-number playing handicap in [0, 36]. */
  const handicapArb = fc.integer({ min: 0, max: 36 });

  it('renders the Day 1 aggregate, combined strokes, combined Stableford, and cumulative relative-to-par cells (Requirements 9.5, 9.8, 9.9, 9.10, 9.16)', () => {
    fc.assert(
      fc.property(
        courseArb,
        cardArb,
        cardArb,
        handicapArb,
        handicapArb,
        (holes, day1Card, day2Card, handicapDay1, handicapDay2) => {
          const player: Player = {
            id: 'p1',
            name: 'Player One',
            handicapDay1,
            handicapDay2,
            cut: false,
          };

          const parByOrdinal = new Map<HoleOrdinal, Par>(
            holes.map((h) => [h.ordinal, h.par]),
          );
          const strokeIndexByHole = new Map(
            holes.map((h) => [h.ordinal, h.strokeIndex]),
          );

          // Per-hole handicap allocations recomputed with the same domain logic
          // the assembler reuses, so expected points are not re-derived by hand.
          const allocDay1 = allocateHandicapStrokes(
            handicapDay1,
            strokeIndexByHole,
          );
          const allocDay2 = allocateHandicapStrokes(
            handicapDay2,
            strokeIndexByHole,
          );
          expect(allocDay1.ok).toBe(true);
          expect(allocDay2.ok).toBe(true);
          if (!allocDay1.ok || !allocDay2.ok) return;

          // Build the score rows and independently recompute the expected
          // combined derivations from the generated cards.
          const day1Scores: Score[] = [];
          const day2Scores: Score[] = [];

          let day1Strokes = 0;
          let day2Strokes = 0;
          let day1Par = 0;
          let day2Par = 0;
          let day1Stableford = 0;
          let day2Stableford = 0;

          HOLE_ORDINALS.forEach((ordinal, i) => {
            const par = parByOrdinal.get(ordinal) as Par;

            const d1 = day1Card[i];
            if (d1.recorded) {
              day1Scores.push({
                playerId: player.id,
                day: 1,
                ordinal,
                gross: d1.gross,
                noReturn: false,
              });
              day1Strokes += d1.gross;
              day1Par += par;
              const pts = stablefordForHole(
                { kind: 'numeric', gross: d1.gross },
                par,
                allocDay1.value.get(ordinal) ?? 0,
              );
              expect(pts.ok).toBe(true);
              if (pts.ok) day1Stableford += pts.value;
            }

            const d2 = day2Card[i];
            if (d2.recorded) {
              day2Scores.push({
                playerId: player.id,
                day: 2,
                ordinal,
                gross: d2.gross,
                noReturn: false,
              });
              day2Strokes += d2.gross;
              day2Par += par;
              const pts = stablefordForHole(
                { kind: 'numeric', gross: d2.gross },
                par,
                allocDay2.value.get(ordinal) ?? 0,
              );
              expect(pts.ok).toBe(true);
              if (pts.ok) day2Stableford += pts.value;
            }
          });

          const expectedTotal36 = day1Stableford + day2Stableford;
          const expectedRelative =
            day1Strokes + day2Strokes - (day1Par + day2Par);
          const hasCompletedHoles = day1Scores.length + day2Scores.length > 0;

          const view = assemblerOver(
            holes,
            [player],
            day1Scores,
            day2Scores,
          ).buildDay2View();
          const row = view.rows.find((r) => r.playerId === player.id);
          expect(row).toBeDefined();
          if (!row) return;

          // A non-CUT, non-NR player's combined cells are all rendered.
          expect(row.cut).toBe(false);

          // 9.5: the Day 1 Aggregate_Strokes column value.
          expect(row.day1AggregateStrokes).toBe(day1Strokes);

          // 9.8: combined strokes cell "day1total (day2total)" (no NR here).
          expect(row.combinedStrokes).not.toBeNull();
          if (row.combinedStrokes) {
            expect(row.combinedStrokes.day1IsNR).toBe(false);
            expect(row.combinedStrokes.day2IsNR).toBe(false);
            expect(row.combinedStrokes.day1Total).toBe(day1Strokes);
            expect(row.combinedStrokes.day2Total).toBe(day2Strokes);
            expect(row.combinedStrokes.text).toBe(
              `${day1Strokes} (${day2Strokes})`,
            );
          }

          // 9.9, 9.16: combined Stableford cell "total36 (day2total)".
          expect(row.combinedStableford).not.toBeNull();
          if (row.combinedStableford) {
            expect(row.combinedStableford.total36).toBe(expectedTotal36);
            expect(row.combinedStableford.day2Total).toBe(day2Stableford);
            expect(row.combinedStableford.text).toBe(
              `${expectedTotal36} (${day2Stableford})`,
            );
          }

          // 9.10: cumulative relative-to-par over completed Day 1+2 holes,
          // rendered signed. With no NR and no completed holes it is empty.
          expect(row.relativeToPar.isNR).toBe(false);
          if (!hasCompletedHoles) {
            expect(row.relativeToPar.text).toBe('');
            expect(row.relativeToPar.value).toBeNull();
          } else {
            expect(row.relativeToPar.value).toBe(expectedRelative);
            const expectedText =
              expectedRelative > 0
                ? `+${expectedRelative}`
                : expectedRelative < 0
                  ? String(expectedRelative)
                  : '0';
            expect(row.relativeToPar.text).toBe(expectedText);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
