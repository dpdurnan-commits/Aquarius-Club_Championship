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
 * Property 30: Day 2 combined NR substitution
 *
 * Validates: Requirements 9.12, 9.13, 9.14, 9.15, 9.16
 *
 * For any Player without CUT status, `ScoresDisplayAssembler.buildDay2View`
 * substitutes "NR" into the Day 2 combined cells per side, driven only by
 * whether that Player has any No_Return hole on each day:
 *  - a Day 1 NR renders the Day 1 portion of the combined strokes cell as "NR",
 *    formatted "NR (day2total)" (9.12);
 *  - a Day 2 NR renders the bracketed Day 2 portion as "NR", formatted
 *    "day1total (NR)" (9.13);
 *  - a Day 1 NR AND a Day 2 NR render the whole combined strokes cell "NR (NR)"
 *    (9.14);
 *  - a Day 1 NR OR a Day 2 NR renders the combined Relative_To_Par cell as "NR"
 *    instead of a signed value (9.15);
 *  - the combined Stableford cell is ALWAYS "total36 (day2total)" with numeric
 *    totals over holes with a numeric gross across both days, regardless of any
 *    NR on either day (9.16).
 *
 * This drives the real assembler over a tiny in-memory repository stub exposing
 * only the three read methods `buildDay2View` uses (`getHoles`, `getPlayers`,
 * `getScoresForDay`), with rows deep-copied so the assembler cannot mutate the
 * generated fixtures. Each day's card cell is one of numeric / NR / unrecorded,
 * so every generated player exercises some point in the NR-combination space;
 * the expected numeric totals are recomputed here with the same domain logic
 * the assembler reuses (`allocateHandicapStrokes` + `stablefordForHole`) rather
 * than re-deriving the Stableford tier rules by hand.
 *
 * A fully configured course (valid pars, a permuted 1..18 stroke-index set)
 * plus whole-number Day 1 and Day 2 handicaps make per-hole points well defined.
 */
describe('Property 30: Day 2 combined NR substitution', () => {
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
   * One hole of a player's day card, covering all three states so the generated
   * card can contain NR on either day:
   *  - numeric: a recorded gross in [1,20];
   *  - NR: a No_Return hole;
   *  - unrecorded: no score row at all.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ kind: 'numeric' as const, gross: gross as Gross })),
    fc.constant({ kind: 'NR' as const }),
    fc.constant({ kind: 'unrecorded' as const }),
  );

  /** A full 18-hole card: one cell per ordinal. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  /** A whole-number playing handicap in [0, 36]. */
  const handicapArb = fc.integer({ min: 0, max: 36 });

  it('substitutes "NR" per side in the combined strokes and relative-to-par cells while keeping the combined Stableford numeric (Requirements 9.12, 9.13, 9.14, 9.15, 9.16)', () => {
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
          // combined derivations from the generated cards. NR/unrecorded holes
          // contribute nothing to strokes/par/points.
          const day1Scores: Score[] = [];
          const day2Scores: Score[] = [];

          let day1Strokes = 0;
          let day2Strokes = 0;
          let day1Par = 0;
          let day2Par = 0;
          let day1Stableford = 0;
          let day2Stableford = 0;
          let day1NR = false;
          let day2NR = false;

          HOLE_ORDINALS.forEach((ordinal, i) => {
            const par = parByOrdinal.get(ordinal) as Par;

            const d1 = day1Card[i];
            if (d1.kind === 'numeric') {
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
            } else if (d1.kind === 'NR') {
              day1Scores.push({
                playerId: player.id,
                day: 1,
                ordinal,
                gross: null,
                noReturn: true,
              });
              day1NR = true;
            }

            const d2 = day2Card[i];
            if (d2.kind === 'numeric') {
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
            } else if (d2.kind === 'NR') {
              day2Scores.push({
                playerId: player.id,
                day: 2,
                ordinal,
                gross: null,
                noReturn: true,
              });
              day2NR = true;
            }
          });

          const anyNR = day1NR || day2NR;
          const expectedTotal36 = day1Stableford + day2Stableford;
          const expectedRelative =
            day1Strokes + day2Strokes - (day1Par + day2Par);
          const hasCompletedHoles =
            day1Scores.filter((s) => !s.noReturn).length +
              day2Scores.filter((s) => !s.noReturn).length >
            0;

          const view = assemblerOver(
            holes,
            [player],
            day1Scores,
            day2Scores,
          ).buildDay2View();
          const row = view.rows.find((r) => r.playerId === player.id);
          expect(row).toBeDefined();
          if (!row) return;

          // A non-CUT player's combined cells are all rendered.
          expect(row.cut).toBe(false);

          // 9.12, 9.13, 9.14: combined strokes cell with per-side NR
          // substitution. The Day 1 portion is "NR" on a Day 1 NR, the bracketed
          // Day 2 portion is "NR" on a Day 2 NR, and both are "NR" when NR on
          // both days.
          expect(row.combinedStrokes).not.toBeNull();
          if (row.combinedStrokes) {
            expect(row.combinedStrokes.day1IsNR).toBe(day1NR);
            expect(row.combinedStrokes.day2IsNR).toBe(day2NR);
            expect(row.combinedStrokes.day1Total).toBe(
              day1NR ? null : day1Strokes,
            );
            expect(row.combinedStrokes.day2Total).toBe(
              day2NR ? null : day2Strokes,
            );

            const day1Text = day1NR ? 'NR' : String(day1Strokes);
            const day2Text = day2NR ? 'NR' : String(day2Strokes);
            expect(row.combinedStrokes.text).toBe(`${day1Text} (${day2Text})`);
          }

          // 9.16: the combined Stableford cell is ALWAYS numeric
          // "total36 (day2total)" regardless of NR on either day.
          expect(row.combinedStableford).not.toBeNull();
          if (row.combinedStableford) {
            expect(row.combinedStableford.total36).toBe(expectedTotal36);
            expect(row.combinedStableford.day2Total).toBe(day2Stableford);
            expect(row.combinedStableford.text).toBe(
              `${expectedTotal36} (${day2Stableford})`,
            );
          }

          // 9.15: the combined Relative_To_Par cell is "NR" whenever the player
          // has any NR on either day, instead of a signed value.
          if (anyNR) {
            expect(row.relativeToPar.isNR).toBe(true);
            expect(row.relativeToPar.text).toBe('NR');
            expect(row.relativeToPar.value).toBeNull();
          } else {
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
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
