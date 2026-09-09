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
 * Property 27: Day 2 ordering
 *
 * Validates: Requirements 9.3, 9.4
 *
 * For any set of players, the assembled Day 2 rows are ordered so that every
 * Player without CUT status precedes every Player with CUT status; non-CUT rows
 * are ordered by cumulative (Day 1 + Day 2) Relative_To_Par ascending, with ties
 * broken alphabetically by Player name (9.3); and CUT rows follow, ordered
 * alphabetically by Player name (9.4).
 *
 * This drives the real `ScoresDisplayAssembler.buildDay2View` over a tiny
 * in-memory repository stub that returns the arbitrary course + roster + Day 1
 * and Day 2 scores under test. Only the three read methods `buildDay2View` uses
 * (`getHoles`, `getPlayers`, `getScoresForDay`) are supplied. The real
 * `Repository.getPlayers` returns players ordered by name, and the assembler's
 * ordering relies on that alphabetical input for its within-tie and CUT
 * tie-breaks, so the stub supplies players sorted by name to honour that
 * contract.
 *
 * Scores are generated numeric-only (never NR), so each non-CUT row's cumulative
 * Relative_To_Par is a well-defined signed value that equals the sort key the
 * assembler orders by — letting the expected ordering be recomputed
 * independently from the generated data.
 */
describe('Property 27: Day 2 ordering', () => {
  /**
   * An assembler whose only persistence dependency is the three read methods
   * `buildDay2View` calls. Rows are deep-copied so the assembler cannot mutate
   * the fixtures.
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
   * or omitted (unrecorded). Never NR — this property concerns the ordering key,
   * which is only a signed value when the player has no NR on either day.
   */
  const cellArb = fc.oneof(
    fc
      .integer({ min: GROSS_MIN, max: GROSS_MAX })
      .map((gross) => ({ recorded: true as const, gross: gross as Gross })),
    fc.constant({ recorded: false as const }),
  );

  /** A full 18-hole card: one cell per ordinal. */
  const cardArb = fc.array(cellArb, { minLength: 18, maxLength: 18 });

  /**
   * A player generated with a distinct alphabetical name (so tie-breaks are
   * observable), a CUT flag, and independent Day 1 and Day 2 cards. Names are
   * assigned by index after generation to guarantee uniqueness and a known
   * alphabetical order.
   */
  const playerSpecArb = fc.record({
    cut: fc.boolean(),
    day1: cardArb,
    day2: cardArb,
  });

  it('orders non-CUT rows by cumulative relative-to-par ascending (alphabetical tie-break) and places CUT rows last alphabetically (Requirements 9.3, 9.4)', () => {
    fc.assert(
      fc.property(
        courseArb,
        fc.array(playerSpecArb, { minLength: 1, maxLength: 8 }),
        (holes, specs) => {
          const parByOrdinal = new Map<HoleOrdinal, number>(
            holes.map((h) => [h.ordinal, h.par as number]),
          );

          // Assign distinct, alphabetically-ordered names: P00, P01, ... The
          // repository returns players by name, so supplying them in this order
          // mirrors the real input the assembler's tie-breaks depend on.
          const players: Player[] = specs.map((_, i) => ({
            id: `p${i}`,
            name: `P${String(i).padStart(2, '0')}`,
            handicapDay1: 12,
            handicapDay2: 12,
            cut: specs[i].cut,
          }));

          const day1Scores: Score[] = [];
          const day2Scores: Score[] = [];
          // Expected cumulative relative-to-par (the assembler's sort key) per
          // player, computed independently from the generated cards.
          const expectedKey = new Map<string, number>();

          specs.forEach((spec, i) => {
            const player = players[i];
            let strokes = 0;
            let par = 0;

            HOLE_ORDINALS.forEach((ordinal, h) => {
              const d1 = spec.day1[h];
              if (d1.recorded) {
                day1Scores.push({
                  playerId: player.id,
                  day: 1,
                  ordinal,
                  gross: d1.gross,
                  noReturn: false,
                });
                strokes += d1.gross;
                par += parByOrdinal.get(ordinal) ?? 0;
              }
              // CUT players do not play Day 2; their Day 2 cards are ignored so
              // no Day 2 scores are recorded for them.
              const d2 = spec.day2[h];
              if (!spec.cut && d2.recorded) {
                day2Scores.push({
                  playerId: player.id,
                  day: 2,
                  ordinal,
                  gross: d2.gross,
                  noReturn: false,
                });
                strokes += d2.gross;
                par += parByOrdinal.get(ordinal) ?? 0;
              }
            });

            expectedKey.set(player.id, strokes - par);
          });

          const view = assemblerOver(
            holes,
            players,
            day1Scores,
            day2Scores,
          ).buildDay2View();

          // Every player appears exactly once.
          expect(view.rows).toHaveLength(players.length);
          expect(new Set(view.rows.map((r) => r.playerId)).size).toBe(
            players.length,
          );

          const nonCut = view.rows.filter((r) => !r.cut);
          const cut = view.rows.filter((r) => r.cut);

          // 9.3 + 9.4: all non-CUT rows precede all CUT rows. Equivalent to the
          // rows being partitioned with no CUT row before a non-CUT row.
          const firstCutIndex = view.rows.findIndex((r) => r.cut);
          if (firstCutIndex !== -1) {
            for (let i = firstCutIndex; i < view.rows.length; i += 1) {
              expect(view.rows[i].cut).toBe(true);
            }
          }

          // 9.3: non-CUT rows ascending by cumulative relative-to-par, ties
          // broken alphabetically by name. Recompute the expected order and
          // compare the resulting player id sequence.
          const expectedNonCut = players
            .filter((p) => !p.cut)
            .slice()
            .sort((a, b) => {
              const ka = expectedKey.get(a.id)!;
              const kb = expectedKey.get(b.id)!;
              if (ka !== kb) return ka - kb;
              return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            })
            .map((p) => p.id);
          expect(nonCut.map((r) => r.playerId)).toEqual(expectedNonCut);

          // 9.4: CUT rows ordered alphabetically by name.
          const expectedCut = players
            .filter((p) => p.cut)
            .slice()
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((p) => p.id);
          expect(cut.map((r) => r.playerId)).toEqual(expectedCut);
        },
      ),
      { numRuns: 100 },
    );
  });
});
