/**
 * StablefordCalculator — pure scoring functions (no I/O, deterministic).
 *
 * This module holds the handicap-allocation and Stableford-points logic used
 * by the score entry and view-assembly layers. Every function here is a pure
 * function of its arguments so it can be property-tested in isolation.
 *
 * This file implements both handicap stroke allocation (Requirement 4) and
 * net strokes with Stableford points mapping (Requirement 5). All functions
 * live in this single module.
 */

import {
  HANDICAP_MAX,
  HANDICAP_MIN,
  HOLE_ORDINALS,
  type CellState,
  type HoleOrdinal,
  type Par,
  type PlayingHandicap,
  type Result,
  type StablefordPoints,
  type StrokeIndex,
  err,
  ok,
} from '@ccs/types';

/**
 * Per-hole handicap stroke allocation: how many handicap strokes each hole
 * receives, keyed by hole ordinal. Values are 0, 1, or 2 (a hole can receive
 * at most 2 strokes because the maximum playing handicap is 36, so the
 * second-stroke threshold `H - 18` is at most 18).
 */
export type HandicapStrokesByHole = ReadonlyMap<HoleOrdinal, number>;

/**
 * The stroke index for each hole, as supplied to the calculator. An entry may
 * be `null`/`undefined` (or the hole may be absent) when the course
 * configuration is incomplete; the calculator treats any such gap as an
 * unavailable input. (Requirement 4.4)
 */
export type StrokeIndexByHole = ReadonlyMap<HoleOrdinal, StrokeIndex | null | undefined>;

/**
 * Allocate handicap strokes to holes from a playing handicap and the course's
 * stroke indices. (Requirement 4)
 *
 * Rules:
 *  - One stroke to each hole whose stroke index <= H. (4.1)
 *  - An additional stroke to each hole whose stroke index <= H - 18. (4.2)
 *  - When H is 0, every hole receives zero strokes. (4.3, falls out of 4.1)
 *  - When the handicap or any of the 18 hole stroke indices is unavailable,
 *    allocation is withheld and an INPUTS_UNAVAILABLE result is returned. (4.4)
 *
 * @param playingHandicap Whole-number handicap in [0, 36], or null/undefined
 *   when not yet entered.
 * @param strokeIndexByHole Map from hole ordinal to that hole's stroke index.
 *   Missing or null entries make the inputs unavailable.
 * @returns A `Result` wrapping the per-hole allocation map, or an
 *   INPUTS_UNAVAILABLE error when inputs are missing.
 */
export function allocateHandicapStrokes(
  playingHandicap: PlayingHandicap | null | undefined,
  strokeIndexByHole: StrokeIndexByHole,
): Result<HandicapStrokesByHole> {
  // Handicap must be an available whole number within the permitted range. (4.4)
  if (
    playingHandicap === null ||
    playingHandicap === undefined ||
    !Number.isInteger(playingHandicap) ||
    playingHandicap < HANDICAP_MIN ||
    playingHandicap > HANDICAP_MAX
  ) {
    return err('Playing handicap is unavailable.', 'INPUTS_UNAVAILABLE');
  }

  // Every one of the 18 holes must have an available stroke index. (4.4)
  const resolvedStrokeIndices = new Map<HoleOrdinal, StrokeIndex>();
  for (const ordinal of HOLE_ORDINALS) {
    const strokeIndex = strokeIndexByHole.get(ordinal);
    if (strokeIndex === null || strokeIndex === undefined) {
      return err(
        `Stroke index for hole ${ordinal} is unavailable.`,
        'INPUTS_UNAVAILABLE',
      );
    }
    resolvedStrokeIndices.set(ordinal, strokeIndex);
  }

  const handicap = playingHandicap;
  const secondStrokeThreshold = handicap - 18;

  const allocation = new Map<HoleOrdinal, number>();
  for (const ordinal of HOLE_ORDINALS) {
    const strokeIndex = resolvedStrokeIndices.get(ordinal) as StrokeIndex;
    let strokes = 0;
    if (strokeIndex <= handicap) {
      strokes += 1; // First stroke. (4.1); no strokes when H = 0. (4.3)
    }
    if (strokeIndex <= secondStrokeThreshold) {
      strokes += 1; // Second stroke, only when H > 18. (4.2)
    }
    allocation.set(ordinal, strokes);
  }

  return ok(allocation);
}

/**
 * Net strokes on a hole: gross strokes minus the handicap strokes allocated to
 * that hole. (Requirement 5.1)
 *
 * @param gross Gross strokes taken on the hole.
 * @param handicapStrokesOnHole Handicap strokes allocated to this hole (0, 1, or 2).
 * @returns The net stroke count for the hole.
 */
export function netStrokes(gross: number, handicapStrokesOnHole: number): number {
  return gross - handicapStrokesOnHole;
}

/**
 * Map net strokes relative to par to Stableford points. (Requirements 5.2–5.7)
 *
 * With `diff = net - par`:
 *  - diff <= -3 (albatross or better) → 5 points. (5.2)
 *  - diff === -2 (eagle)              → 4 points. (5.3)
 *  - diff === -1 (birdie)             → 3 points. (5.4)
 *  - diff === 0  (par)                → 2 points. (5.5)
 *  - diff === +1 (bogey)              → 1 point.  (5.6)
 *  - diff >= +2  (double bogey+)      → 0 points. (5.7)
 *
 * @param net Net strokes on the hole.
 * @param par Par for the hole.
 * @returns The Stableford points earned, in the range 0..5.
 */
export function stablefordPoints(net: number, par: number): StablefordPoints {
  const diff = net - par;
  if (diff <= -3) return 5; // (5.2)
  if (diff === -2) return 4; // (5.3)
  if (diff === -1) return 3; // (5.4)
  if (diff === 0) return 2; // (5.5)
  if (diff === 1) return 1; // (5.6)
  return 0; // (5.7)
}

/**
 * Input accepted for a hole's gross score: either a raw number (to be
 * validated) or an already-derived CellState carrying its state.
 */
export type GrossInput = number | CellState;

/**
 * Compute the Stableford points for a single hole from its gross input, par,
 * and the handicap strokes allocated to that hole. (Requirement 5)
 *
 * Behaviour:
 *  - A CellState of kind 'unrecorded' scores zero points. (5.9)
 *  - A CellState of kind 'NR' (no return) scores zero points. (5.10)
 *  - A numeric CellState uses its validated gross to compute points. (5.1–5.7)
 *  - A raw number must be an integer of 1 or greater; otherwise the input is
 *    rejected. (5.8)
 *  - Any other valid raw number is converted to net strokes and mapped to
 *    Stableford points. (5.1–5.7)
 *
 * @param gross The gross input for the hole (raw number or CellState).
 * @param par Par for the hole.
 * @param handicapStrokesOnHole Handicap strokes allocated to this hole.
 * @returns A `Result` wrapping the Stableford points, or an INVALID error when
 *   a raw gross number is out of the permitted domain.
 */
export function stablefordForHole(
  gross: GrossInput,
  par: Par,
  handicapStrokesOnHole: number,
): Result<StablefordPoints> {
  if (typeof gross !== 'number') {
    // CellState branch.
    if (gross.kind === 'unrecorded') {
      return ok(0); // No score recorded scores zero. (5.9)
    }
    if (gross.kind === 'NR') {
      return ok(0); // No return scores zero. (5.10)
    }
    // Numeric cell state: carries a validated gross value. (5.1–5.7)
    return ok(
      stablefordPoints(netStrokes(gross.gross, handicapStrokesOnHole), par),
    );
  }

  // Raw number branch: must be an integer of 1 or greater. (5.8)
  if (!Number.isInteger(gross) || gross < 1) {
    return err('Gross strokes must be an integer of 1 or greater.', 'INVALID');
  }

  return ok(stablefordPoints(netStrokes(gross, handicapStrokesOnHole), par)); // (5.1–5.7)
}
