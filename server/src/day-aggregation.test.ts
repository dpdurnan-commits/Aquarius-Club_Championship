import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  HOLE_ORDINALS,
  cellStateOf,
  isOk,
  type Day,
  type Gross,
  type Hole,
  type HoleOrdinal,
  type Par,
  type Player,
  type Score,
  type StrokeIndex,
} from '@ccs/types';
import { aggregateStableford, type DayAggregationInput } from './day-aggregation.js';
import {
  allocateHandicapStrokes,
  stablefordForHole,
  type StrokeIndexByHole,
} from './stableford-calculator.js';

/**
 * Feature: club-championship-scoring
 * Property 12: Aggregate Stableford sums only numeric holes, independent of NR
 *
 * Validates: Requirements 5.9, 5.10, 5.11, 8.7, 8.15, 9.16
 *
 * For any day's scores for a player, the aggregate Stableford equals the sum of
 * hole points over exactly the holes with a numeric gross, where NR holes and
 * unrecorded holes contribute 0 — and this holds whether or not the day
 * contains any NR hole.
 */
describe('Property 12: Aggregate Stableford sums only numeric holes, independent of NR', () => {
  // Par for a hole is an integer 3..6. (types Par)
  const parArb = fc.constantFrom<Par>(3, 4, 5, 6);

  // A recorded numeric gross is an integer in [1, 20]. (Requirement 7.3)
  const grossArb = fc.integer({ min: 1, max: 20 }) as fc.Arbitrary<Gross>;

  // A full permutation of stroke indices {1..18} assigned to holes in ordinal
  // order, so every hole has a distinct, valid stroke index.
  const strokeIndexOrderArb = fc.shuffledSubarray(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    { minLength: 18, maxLength: 18 },
  ) as fc.Arbitrary<StrokeIndex[]>;

  // A configured 18-hole course: each hole gets its own par and a stroke index
  // drawn from the permutation.
  const holesArb: fc.Arbitrary<Hole[]> = fc
    .tuple(
      fc.array(parArb, { minLength: 18, maxLength: 18 }),
      strokeIndexOrderArb,
    )
    .map(([pars, siOrder]) =>
      HOLE_ORDINALS.map((ordinal, i) => ({
        ordinal,
        par: pars[i],
        strokeIndex: siOrder[i],
      })),
    );

  // Playing handicap, a whole number in [0, 36]. (Requirement 2.5)
  const handicapArb = fc.integer({ min: 0, max: 36 });

  // A single cell's recorded state, chosen among the three real-world shapes:
  //  - unrecorded (no row for the hole),
  //  - numeric gross,
  //  - NR (no return).
  type CellChoice =
    | { kind: 'unrecorded' }
    | { kind: 'numeric'; gross: Gross }
    | { kind: 'NR' };

  const numericChoiceArb: fc.Arbitrary<CellChoice> = grossArb.map((gross) => ({
    kind: 'numeric',
    gross,
  }));
  const unrecordedChoiceArb = fc.constant<CellChoice>({ kind: 'unrecorded' });
  const nrChoiceArb = fc.constant<CellChoice>({ kind: 'NR' });

  // General cell distribution: any of the three states.
  const anyCellArb = fc.oneof(numericChoiceArb, unrecordedChoiceArb, nrChoiceArb);
  // A day guaranteed to contain no NR: only numeric or unrecorded.
  const noNRCellArb = fc.oneof(numericChoiceArb, unrecordedChoiceArb);

  // One cell choice per hole, in ordinal order.
  const dayCellsArb = (cell: fc.Arbitrary<CellChoice>) =>
    fc.array(cell, { minLength: 18, maxLength: 18 });

  const playerId = 'p1';

  // Build the Score rows for a day from the per-hole choices. Unrecorded holes
  // produce no row (the aggregator treats absence as unrecorded); numeric and
  // NR holes produce a corresponding row. Rows for the other day / other
  // players are added as noise to prove they are ignored.
  function buildScores(choices: readonly CellChoice[], day: Day): Score[] {
    const scores: Score[] = [];
    for (let i = 0; i < HOLE_ORDINALS.length; i++) {
      const ordinal = HOLE_ORDINALS[i];
      const choice = choices[i];
      if (choice.kind === 'numeric') {
        scores.push({ playerId, day, ordinal, gross: choice.gross, noReturn: false });
      } else if (choice.kind === 'NR') {
        scores.push({ playerId, day, ordinal, gross: null, noReturn: true });
      }
      // unrecorded → no row.
    }
    return scores;
  }

  // Independent oracle: sum the Stableford points over exactly the numeric
  // holes using the same handicap-stroke allocation the aggregator would use.
  // NR and unrecorded holes contribute 0 by construction. (5.9, 5.10, 5.11)
  function expectedAggregate(input: DayAggregationInput): number {
    const handicap =
      input.day === 1 ? input.player.handicapDay1 : input.player.handicapDay2;
    const strokeIndexByHole: StrokeIndexByHole = new Map(
      input.holes.map((hole) => [hole.ordinal, hole.strokeIndex]),
    );
    const allocation = allocateHandicapStrokes(handicap, strokeIndexByHole);
    const strokesByHole = isOk(allocation) ? allocation.value : null;

    const byOrdinal = new Map<HoleOrdinal, Score>();
    for (const score of input.scores) {
      if (score.playerId === input.player.id && score.day === input.day) {
        byOrdinal.set(score.ordinal, score);
      }
    }
    const parByOrdinal = new Map<HoleOrdinal, Par | null>(
      input.holes.map((hole) => [hole.ordinal, hole.par]),
    );

    let total = 0;
    for (const ordinal of HOLE_ORDINALS) {
      const state = cellStateOf(byOrdinal.get(ordinal));
      if (state.kind !== 'numeric') continue; // NR / unrecorded contribute 0.
      const par = parByOrdinal.get(ordinal);
      if (par === null || par === undefined) continue;
      const strokesOnHole = strokesByHole?.get(ordinal) ?? 0;
      const points = stablefordForHole(state, par, strokesOnHole);
      if (isOk(points)) total += points.value;
    }
    return total;
  }

  function runProperty(cellArb: fc.Arbitrary<CellChoice>, requireNRPresence: boolean | null) {
    fc.assert(
      fc.property(
        holesArb,
        handicapArb,
        handicapArb,
        fc.constantFrom<Day>(1, 2),
        dayCellsArb(cellArb),
        (holes, handicapDay1, handicapDay2, day, choices) => {
          const player: Player = {
            id: playerId,
            name: 'Test Player',
            handicapDay1,
            handicapDay2,
            cut: false,
          };

          // Noise: the other day's rows and another player's rows must not
          // affect this day's aggregate.
          const otherDay: Day = day === 1 ? 2 : 1;
          const noise: Score[] = [
            ...buildScores(choices, otherDay),
            ...HOLE_ORDINALS.map((ordinal) => ({
              playerId: 'other-player',
              day,
              ordinal,
              gross: 7 as Gross,
              noReturn: false,
            })),
          ];

          const dayScores = buildScores(choices, day);
          const input: DayAggregationInput = {
            player,
            day,
            scores: [...dayScores, ...noise],
            holes,
          };

          // Precondition: exercise the requested NR branch (present / absent).
          const hasNR = choices.some((c) => c.kind === 'NR');
          if (requireNRPresence !== null) {
            fc.pre(hasNR === requireNRPresence);
          }

          expect(aggregateStableford(input)).toBe(expectedAggregate(input));

          return true;
        },
      ),
      { numRuns: 100 },
    );
  }

  it('sums Stableford points over exactly the numeric holes (NR/unrecorded contribute 0)', () => {
    runProperty(anyCellArb, null);
  });

  it('holds when the day contains at least one NR hole', () => {
    runProperty(anyCellArb, true);
  });

  it('holds when the day contains no NR hole', () => {
    runProperty(noNRCellArb, false);
  });
});
