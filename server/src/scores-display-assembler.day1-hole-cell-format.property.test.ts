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
 * Property 24: Day 1 hole cell format
 *
 * Validates: Requirements 8.3, 8.4, 8.11
 *
 * For any Day 1 hole score cell, `ScoresDisplayAssembler.buildDay1View` renders
 * the cell as:
 *  - a recorded numeric gross → "gross (points)" with kind 'numeric' (8.3);
 *  - an unrecorded hole (no gross recorded) → an empty cell (8.4);
 *  - an NR hole → "NR" (8.11).
 *
 * This drives the real assembler over a tiny in-memory repository stub exposing
 * only the three read methods `buildDay1View` uses (`getHoles`, `getPlayers`,
 * `getScoresForDay`). Day 2 scores are never requested, so `getScoresForDay(2)`
 * returns an empty list. A fully configured course (valid pars, a permuted 1..18
 * stroke-index set) plus a whole-number handicap is used so per-hole points are
 * well defined; the expected "gross (points)" text is recomputed here with the
 * same domain logic (`allocateHandicapStrokes` + `stablefordForHole`) the
 * assembler reuses, rather than re-deriving the Stableford rules by hand.
 */
describe('Property 24: Day 1 hole cell format', () => {
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
   * A single Day 1 hole cell for a player, covering all three states the
   * property distinguishes:
   *  - numeric: a recorded gross in [1,20] (8.3);
   *  - NR: no return (8.11);
   *  - unrecorded: no score at all (8.4).
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ kind: 'numeric' as const, gross: gross as Gross })),
    fc.constant({ kind: 'NR' as const }),
    fc.constant({ kind: 'unrecorded' as const }),
  );

  /** A player's full 18-hole Day 1 card, one cell per ordinal. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  /** A whole-number Day 1 playing handicap in [0, 36]. */
  const handicapArb = fc.integer({ min: 0, max: 36 });

  it('renders each Day 1 hole cell as "gross (points)", empty, or "NR" (Requirements 8.3, 8.4, 8.11)', () => {
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
        // the assembler reuses, so the expected points are not re-derived by hand.
        const strokeIndexByHole = new Map(
          holes.map((h) => [h.ordinal, h.strokeIndex]),
        );
        const allocation = allocateHandicapStrokes(handicap, strokeIndexByHole);
        expect(allocation.ok).toBe(true);
        const parByOrdinal = new Map<number, Par>(
          holes.map((h) => [h.ordinal, h.par]),
        );

        const view = assemblerOver(holes, [player], scores).buildDay1View();
        const row = view.rows.find((r) => r.playerId === player.id);
        expect(row).toBeDefined();
        if (!row) return;
        expect(row.holes).toHaveLength(18);

        HOLE_ORDINALS.forEach((ordinal, i) => {
          const cell = card[i];
          const rendered = row.holes[i];

          if (cell.kind === 'unrecorded') {
            // 8.4: no gross recorded renders as an empty cell.
            expect(rendered.kind).toBe('empty');
            expect(rendered.text).toBe('');
            return;
          }

          if (cell.kind === 'NR') {
            // 8.11: an NR hole renders as "NR".
            expect(rendered.kind).toBe('NR');
            expect(rendered.text).toBe('NR');
            return;
          }

          // 8.3: a numeric gross renders as "gross (points)".
          expect(rendered.kind).toBe('numeric');
          if (rendered.kind !== 'numeric') return;

          const par = parByOrdinal.get(ordinal) as Par;
          const strokesOnHole = allocation.ok
            ? (allocation.value.get(ordinal) ?? 0)
            : 0;
          const points = stablefordForHole(
            { kind: 'numeric', gross: cell.gross },
            par,
            strokesOnHole,
          );
          expect(points.ok).toBe(true);
          const expectedPoints = points.ok ? points.value : 0;

          expect(rendered.gross).toBe(cell.gross);
          expect(rendered.points).toBe(expectedPoints);
          expect(rendered.text).toBe(`${cell.gross} (${expectedPoints})`);
        });
      }),
      { numRuns: 100 },
    );
  });
});
