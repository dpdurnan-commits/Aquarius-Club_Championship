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

/**
 * Feature: club-championship-scoring
 * Property 31: CUT player Day 2 rendering
 *
 * Validates: Requirements 9.17, 9.18
 *
 * For any Player with CUT status, `ScoresDisplayAssembler.buildDay2View`
 * produces that player's Day 2 row so that:
 *  - the row is flagged CUT so "CUT" is displayed against the player's name on
 *    the Day 2 table (9.17); and
 *  - no Day 2 hole scores are shown (every one of the 18 per-hole cells is
 *    empty), and no Day 2 Aggregate_Strokes / aggregate totals are shown — the
 *    combined-strokes and combined-Stableford cells are absent and the
 *    cumulative relative-to-par cell is empty (9.18).
 *
 * The suppression must hold even when the repository still contains Day 2 score
 * rows for the CUT player: generating recorded Day 2 holes (numeric or NR) and
 * then asserting they never surface proves the assembler withholds them rather
 * than merely relying on their absence.
 *
 * This drives the real assembler over the same tiny in-memory repository stub
 * used by the other Day 2 assembler properties, exposing only the three read
 * methods `buildDay2View` uses (`getHoles`, `getPlayers`, `getScoresForDay`),
 * with rows deep-copied so the assembler cannot mutate the generated fixtures.
 */
describe('Property 31: CUT player Day 2 rendering', () => {
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
   * One hole of a player's day card: a numeric gross (completed), a No_Return,
   * or omitted (unrecorded). NR is included here so the test also proves NR
   * Day 2 holes are suppressed for a CUT player.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ kind: 'numeric' as const, gross: gross as Gross })),
    fc.constant({ kind: 'nr' as const }),
    fc.constant({ kind: 'unrecorded' as const }),
  );

  /** A full 18-hole card: one cell per ordinal. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  /** A whole-number playing handicap in [0, 36]. */
  const handicapArb = fc.integer({ min: 0, max: 36 });

  it('shows "CUT" against the name and suppresses every Day 2 hole score, aggregate strokes, and aggregate total (Requirements 9.17, 9.18)', () => {
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
            name: 'Cut Player',
            handicapDay1,
            handicapDay2,
            cut: true,
          };

          // Build both days' score rows from the generated cards. The Day 2
          // rows are deliberately populated so the test proves suppression of
          // present-but-withheld data, not just the absence of Day 2 scores.
          const day1Scores: Score[] = [];
          const day2Scores: Score[] = [];

          HOLE_ORDINALS.forEach((ordinal, i) => {
            const d1 = day1Card[i];
            if (d1.kind === 'numeric') {
              day1Scores.push({
                playerId: player.id,
                day: 1,
                ordinal,
                gross: d1.gross,
                noReturn: false,
              });
            } else if (d1.kind === 'nr') {
              day1Scores.push({
                playerId: player.id,
                day: 1,
                ordinal,
                gross: null,
                noReturn: true,
              });
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
            } else if (d2.kind === 'nr') {
              day2Scores.push({
                playerId: player.id,
                day: 2,
                ordinal,
                gross: null,
                noReturn: true,
              });
            }
          });

          const view = assemblerOver(
            holes,
            [player],
            day1Scores,
            day2Scores,
          ).buildDay2View();
          const row = view.rows.find((r) => r.playerId === player.id);
          expect(row).toBeDefined();
          if (!row) return;

          // 9.17: the row is flagged CUT so "CUT" is displayed against the name.
          expect(row.cut).toBe(true);

          // 9.18: no Day 2 hole scores — all 18 cells are empty.
          expect(row.holes).toHaveLength(18);
          for (const cell of row.holes) {
            expect(cell.kind).toBe('empty');
            expect(cell.text).toBe('');
          }

          // 9.18: no Day 2 aggregate totals — combined cells are absent and the
          // cumulative relative-to-par cell is empty (no value, not NR).
          expect(row.combinedStrokes).toBeNull();
          expect(row.combinedStableford).toBeNull();
          expect(row.relativeToPar.value).toBeNull();
          expect(row.relativeToPar.text).toBe('');
          expect(row.relativeToPar.isNR).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
