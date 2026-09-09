/**
 * Day aggregation helpers — pure functions over raw Score + Hole + Player rows.
 *
 * These helpers derive the per-day values the ranking, cut, and view-assembly
 * layers depend on. They are all pure functions of their arguments (no I/O),
 * so they can be property-tested in isolation, and they reuse the
 * StablefordCalculator for handicap allocation and per-hole points.
 *
 * Derived value definitions (see design "Derived value definitions"):
 *  - completedHoles(player, day) = Day holes with a numeric gross recorded.
 *  - aggregateStrokes(player, day) = Σ gross over completed holes (numeric-only).
 *  - aggregateStableford(player, day) = Σ stablefordPoints over holes with a
 *    numeric gross (NR/unrecorded contribute 0).
 *  - relativeToPar(player, day) = aggregateStrokes − Σ par over completed holes.
 *  - A player "has NR on day d" iff any cell (player, d, *) has noReturn = true.
 *
 * A score cell is one of three states: unrecorded (no row / gross null and not
 * NR), numeric (gross in [1,20], noReturn false), or NR (noReturn true, gross
 * null). See `CellState` in @ccs/types. (Requirements 5.9, 5.10, 5.11)
 */

import {
  HOLE_ORDINALS,
  cellStateOf,
  isOk,
  type CellState,
  type Day,
  type Gross,
  type Hole,
  type HoleOrdinal,
  type Player,
  type Score,
} from '@ccs/types';
import {
  allocateHandicapStrokes,
  stablefordForHole,
  type HandicapStrokesByHole,
  type StrokeIndexByHole,
} from './stableford-calculator.js';

/**
 * The inputs a day aggregation needs: the player, the day being aggregated,
 * that player's scores (any set — only the ones matching `day` are used), and
 * the course's 18 holes. Passing the raw rows keeps these helpers pure and
 * decoupled from persistence.
 */
export interface DayAggregationInput {
  readonly player: Player;
  readonly day: Day;
  /** Score rows; only those with `day === day` are considered. */
  readonly scores: readonly Score[];
  /** The course holes (up to 18), used for par and stroke index. */
  readonly holes: readonly Hole[];
}

/** A hole ordinal paired with the numeric gross recorded on it. */
export interface CompletedHole {
  readonly ordinal: HoleOrdinal;
  readonly gross: Gross;
}

/**
 * Index the player's scores for a single day by hole ordinal, resolving each to
 * its `CellState`. Holes with no row resolve to `unrecorded`.
 */
function cellStatesForDay(
  input: DayAggregationInput,
): Map<HoleOrdinal, CellState> {
  const byOrdinal = new Map<HoleOrdinal, Score>();
  for (const score of input.scores) {
    if (score.playerId === input.player.id && score.day === input.day) {
      byOrdinal.set(score.ordinal, score);
    }
  }

  const states = new Map<HoleOrdinal, CellState>();
  for (const ordinal of HOLE_ORDINALS) {
    states.set(ordinal, cellStateOf(byOrdinal.get(ordinal)));
  }
  return states;
}

/** Index the course holes by ordinal for lookup. */
function holesByOrdinal(
  holes: readonly Hole[],
): Map<HoleOrdinal, Hole> {
  const byOrdinal = new Map<HoleOrdinal, Hole>();
  for (const hole of holes) {
    byOrdinal.set(hole.ordinal, hole);
  }
  return byOrdinal;
}

/**
 * Whether the player has any No_Return recorded on the given day: true iff at
 * least one cell (player, day, *) is in the NR state. (design: "has NR on day")
 *
 * @param input Player, day, scores, and holes.
 * @returns True when any of the day's holes is recorded as NR.
 */
export function hasNROnDay(input: DayAggregationInput): boolean {
  for (const state of cellStatesForDay(input).values()) {
    if (state.kind === 'NR') {
      return true;
    }
  }
  return false;
}

/**
 * The player's completed holes for the day: every Day hole with a numeric gross
 * recorded, in ascending ordinal order. NR and unrecorded holes are excluded.
 * (Requirement 8.5; design "completedHoles")
 *
 * @param input Player, day, scores, and holes.
 * @returns Completed holes with their gross values, ascending by ordinal.
 */
export function completedHoles(
  input: DayAggregationInput,
): readonly CompletedHole[] {
  const states = cellStatesForDay(input);
  const completed: CompletedHole[] = [];
  for (const ordinal of HOLE_ORDINALS) {
    const state = states.get(ordinal);
    if (state && state.kind === 'numeric') {
      completed.push({ ordinal, gross: state.gross });
    }
  }
  return completed;
}

/**
 * Aggregate strokes for the day: the sum of gross over the player's completed
 * (numeric) holes. NR and unrecorded holes contribute nothing, so a day with no
 * completed holes aggregates to 0. (Requirement 8.5)
 *
 * @param input Player, day, scores, and holes.
 * @returns The sum of gross strokes over completed holes.
 */
export function aggregateStrokes(input: DayAggregationInput): number {
  let total = 0;
  for (const hole of completedHoles(input)) {
    total += hole.gross;
  }
  return total;
}

/**
 * Resolve the per-hole handicap stroke allocation for the day, if the inputs
 * are available (the day's playing handicap plus all 18 stroke indices).
 * Returns null when allocation is withheld (incomplete course / missing
 * handicap), in which case every hole is treated as receiving 0 handicap
 * strokes. (Requirement 4.4)
 */
function resolveHandicapStrokes(
  input: DayAggregationInput,
): HandicapStrokesByHole | null {
  const handicap =
    input.day === 1 ? input.player.handicapDay1 : input.player.handicapDay2;

  const strokeIndexByHole: StrokeIndexByHole = new Map(
    input.holes.map((hole) => [hole.ordinal, hole.strokeIndex]),
  );

  const allocation = allocateHandicapStrokes(handicap, strokeIndexByHole);
  return isOk(allocation) ? allocation.value : null;
}

/**
 * Aggregate Stableford for the day: the sum of Stableford points over exactly
 * the holes with a numeric gross. NR holes and unrecorded holes contribute 0,
 * and this holds whether or not the day contains any NR hole. (Requirements
 * 5.9, 5.10, 5.11, 8.7, 8.15, 9.16)
 *
 * Points require par and handicap-stroke allocation; when either is unavailable
 * for a hole (incomplete course or missing handicap), that hole contributes 0
 * points rather than raising — aggregation is defined over available data only.
 *
 * @param input Player, day, scores, and holes.
 * @returns The sum of Stableford points over the day's numeric holes.
 */
export function aggregateStableford(input: DayAggregationInput): number {
  const states = cellStatesForDay(input);
  const holes = holesByOrdinal(input.holes);
  const handicapStrokes = resolveHandicapStrokes(input);

  let total = 0;
  for (const ordinal of HOLE_ORDINALS) {
    const state = states.get(ordinal);
    // NR and unrecorded holes contribute 0. (5.9, 5.10, 5.11)
    if (!state || state.kind !== 'numeric') {
      continue;
    }

    const par = holes.get(ordinal)?.par;
    // Without a configured par no points can be computed; contribute 0.
    if (par === null || par === undefined) {
      continue;
    }

    const strokesOnHole = handicapStrokes?.get(ordinal) ?? 0;
    const points = stablefordForHole(state, par, strokesOnHole);
    if (isOk(points)) {
      total += points.value;
    }
  }
  return total;
}

/**
 * Relative to par for the day: aggregate strokes minus the total par of the
 * player's completed holes. Positive means over par, negative means under, 0
 * means level. NR handling and empty-state ("no completed holes") formatting is
 * a view-layer concern and is not applied here. (Requirement 8.9)
 *
 * @param input Player, day, scores, and holes.
 * @returns Aggregate strokes minus the total par of completed holes.
 */
export function relativeToPar(input: DayAggregationInput): number {
  const holes = holesByOrdinal(input.holes);
  const completed = completedHoles(input);

  let strokes = 0;
  let parTotal = 0;
  for (const hole of completed) {
    strokes += hole.gross;
    parTotal += holes.get(hole.ordinal)?.par ?? 0;
  }
  return strokes - parTotal;
}
