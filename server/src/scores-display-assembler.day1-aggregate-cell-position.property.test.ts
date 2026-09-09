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
 * Property 25: Day 1 aggregate cell format with position
 *
 * Validates: Requirements 8.6, 8.8
 *
 * For any field of players where no player has a Day 1 NR and each player has at
 * least one completed Day 1 hole, the aggregate-strokes cell renders
 * "aggregateStrokes (scratchPosition)" (8.6) and the aggregate-Stableford cell
 * renders "aggregateStableford (stablefordPosition)" (8.8), where the bracketed
 * position is the player's standard competition ranking across the whole field:
 * ascending by aggregate strokes for the Scratch_Strokeplay_Competition and
 * descending by aggregate Stableford for the Stableford_Competition, with tied
 * players sharing a position and subsequent positions skipping accordingly.
 *
 * This drives the real `ScoresDisplayAssembler.buildDay1View` over a tiny
 * in-memory repository stub that returns the arbitrary course + roster + Day 1
 * scores under test. Only the three read methods `buildDay1View` uses
 * (`getHoles`, `getPlayers`, `getScoresForDay`) are supplied. Every generated
 * card is numeric-only with at least one recorded hole, so no player has an NR
 * and every player is ranked — exactly the precondition of the property. A fully
 * configured course (valid pars, permuted stroke indices) is used so per-hole
 * points are computable and both aggregates are well defined.
 *
 * Rather than re-derive Stableford points here (which would duplicate the
 * production math and risk masking a real defect), the expected position is
 * computed by standard competition ranking directly from the field of totals the
 * assembler itself reports. This asserts exactly what 8.6/8.8 require: that each
 * bracketed position is consistent with the whole field's aggregates.
 */
describe('Property 25: Day 1 aggregate cell format with position', () => {
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

  /**
   * Standard competition ranking over (playerId, value): ties share a position
   * and the next distinct value's position skips by the size of the preceding
   * tie group (1, 2, 2, 4). `order` is 'asc' (lowest value = position 1, for
   * scratch strokes) or 'desc' (highest value = position 1, for Stableford).
   * (Requirements 6.1, 6.2)
   */
  const standardRanking = (
    entries: readonly { playerId: string; value: number }[],
    order: 'asc' | 'desc',
  ): Map<string, number> => {
    const sorted = [...entries].sort((a, b) =>
      order === 'asc' ? a.value - b.value : b.value - a.value,
    );
    const positions = new Map<string, number>();
    let index = 0;
    while (index < sorted.length) {
      let last = index;
      while (last + 1 < sorted.length && sorted[last + 1]!.value === sorted[index]!.value) {
        last += 1;
      }
      const shared = index + 1;
      for (let k = index; k <= last; k += 1) {
        positions.set(sorted[k]!.playerId, shared);
      }
      index = last + 1;
    }
    return positions;
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
   * concerns players with no NR that day.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ recorded: true as const, gross: gross as Gross })),
    fc.constant({ recorded: false as const }),
  );

  /**
   * A player's full 18-hole Day 1 card with AT LEAST ONE recorded hole: 18 cells
   * (numeric or omitted) plus an index forced to be numeric, guaranteeing the
   * player is ranked (no all-empty card, which would still be non-NR but is the
   * separate no-completed-holes case covered elsewhere).
   */
  const cardArb = fc
    .tuple(
      fc.array(cellArb, { minLength: 18, maxLength: 18 }),
      fc.integer({ min: 0, max: 17 }),
      fc.integer({ min: GROSS_MIN, max: GROSS_MAX }),
    )
    .map(([cells, forcedIndex, forcedGross]) => {
      const card = [...cells];
      card[forcedIndex] = { recorded: true as const, gross: forcedGross as Gross };
      return card;
    });

  it('renders the aggregate-strokes and aggregate-Stableford cells as "total (position)" with the field-wide standard competition position (Requirements 8.6, 8.8)', () => {
    fc.assert(
      fc.property(
        // A field of 1..6 players, each with a numeric-only card and at least
        // one completed hole.
        fc.array(cardArb, { minLength: 1, maxLength: 6 }),
        courseArb,
        (cards, holes) => {
          const players: Player[] = cards.map((_, i) => ({
            id: `p${i}`,
            name: `Player ${i}`,
            handicapDay1: 12,
            handicapDay2: 12,
            cut: false,
          }));

          const scores: Score[] = [];
          cards.forEach((card, playerIndex) => {
            HOLE_ORDINALS.forEach((ordinal, holeIndex) => {
              const cell = card[holeIndex];
              if (cell.recorded) {
                scores.push({
                  playerId: players[playerIndex]!.id,
                  day: 1,
                  ordinal,
                  gross: cell.gross,
                  noReturn: false,
                });
              }
            });
          });

          const view = assemblerOver(holes, players, scores).buildDay1View();

          // Derive the expected field-wide positions from the totals the
          // assembler itself reports: scratch ranks by strokes ascending,
          // Stableford ranks by points descending. (6.1, 6.2)
          const strokesEntries = view.rows.map((r) => ({
            playerId: r.playerId,
            value: r.aggregateStrokes.total,
          }));
          const stablefordEntries = view.rows.map((r) => ({
            playerId: r.playerId,
            value: r.aggregateStableford.total,
          }));
          const expectedScratch = standardRanking(strokesEntries, 'asc');
          const expectedStableford = standardRanking(stablefordEntries, 'desc');

          for (const row of view.rows) {
            const scratchPos = expectedScratch.get(row.playerId)!;
            const stablefordPos = expectedStableford.get(row.playerId)!;

            // 8.6: aggregate-strokes cell renders "total (position)".
            expect(row.aggregateStrokes.isNR).toBe(false);
            expect(row.aggregateStrokes.position).toBe(scratchPos);
            expect(row.aggregateStrokes.text).toBe(
              `${row.aggregateStrokes.total} (${scratchPos})`,
            );

            // 8.8: aggregate-Stableford cell renders "total (position)".
            expect(row.aggregateStableford.isNR).toBe(false);
            expect(row.aggregateStableford.position).toBe(stablefordPos);
            expect(row.aggregateStableford.text).toBe(
              `${row.aggregateStableford.total} (${stablefordPos})`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
