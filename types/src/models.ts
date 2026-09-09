/**
 * Persistent domain data models, mirroring the SQLite schema described in the
 * design's Data Models section. Derived values (aggregates, points, positions)
 * are NOT stored and therefore NOT represented here; only CUT is a persisted
 * status (set at Day 1 completion).
 */

import type {
  Day,
  Gross,
  HoleOrdinal,
  Par,
  PlayingHandicap,
  StrokeIndex,
} from './primitives.js';

/**
 * A single hole. Exactly 18 rows exist, keyed by `ordinal`. `par` and
 * `strokeIndex` are null until configured. (Requirements 1.1, 1.8)
 */
export interface Hole {
  readonly ordinal: HoleOrdinal;
  readonly par: Par | null;
  readonly strokeIndex: StrokeIndex | null;
}

/**
 * A championship participant. Day 1 and Day 2 handicaps are stored
 * independently. `cut` is evaluated and persisted at Day 1 completion.
 *
 * `orderDay1` and `orderDay2` are the administrator-controlled display sequence
 * for each day, kept independently because players arrive at scorer checkpoints
 * in a different order on Day 1 than on Day 2. They drive the row order of the
 * Score Entry grid. Lower values sort first. A newly created player is appended
 * to the end of both days' orders. (Score Entry grid ordering)
 * (Requirements 2, 3.9)
 */
export interface Player {
  readonly id: string;
  readonly name: string;
  readonly handicapDay1: PlayingHandicap | null;
  readonly handicapDay2: PlayingHandicap | null;
  readonly cut: boolean;
  /**
   * An administrator override that cuts a player from Day 2 regardless of the
   * automatic Day 1 cut evaluation — used for players who will not return for
   * Day 2 even though they made the cut. Unlike `cut` (which is re-derived each
   * time Day 1 is completed), `manualCut` persists across Day 1 re-completion
   * and reversal. The effective `cut` flag is the automatic cut OR this override.
   */
  readonly manualCut: boolean;
  readonly orderDay1: number;
  readonly orderDay2: number;
}

/**
 * A single score cell keyed by `(playerId, day, ordinal)`. A cell is in one of
 * three states derived from these fields (see CellState):
 *  - unrecorded: no row / gross null and noReturn false
 *  - numeric:    gross in [1,20], noReturn false
 *  - NR:         noReturn true, gross null
 * (Requirements 7.5, 7.11)
 */
export interface Score {
  readonly playerId: string;
  readonly day: Day;
  readonly ordinal: HoleOrdinal;
  readonly gross: Gross | null;
  readonly noReturn: boolean;
}

/**
 * Single-row competition state. When Day 1 is not complete, `cutValue` is null
 * and no player is CUT. (Requirements 3.8, 3.9)
 */
export interface CompetitionState {
  readonly day1Complete: boolean;
  /** Positive integer when Day 1 is complete; null otherwise. */
  readonly cutValue: number | null;
}

/**
 * The three mutually exclusive states a score cell can be in. Used across the
 * calculator and view assembler to drive rendering and point computation.
 */
export type CellState =
  | { readonly kind: 'unrecorded' }
  | { readonly kind: 'numeric'; readonly gross: Gross }
  | { readonly kind: 'NR' };

/** Convenience constant for the unrecorded cell state. */
export const UNRECORDED: CellState = { kind: 'unrecorded' };

/** Convenience constant for the NR cell state. */
export const NO_RETURN: CellState = { kind: 'NR' };

/** Construct a numeric cell state. */
export function numericCell(gross: Gross): CellState {
  return { kind: 'numeric', gross };
}

/** Derive the CellState for a persisted Score row (or absence of one). */
export function cellStateOf(score: Score | undefined | null): CellState {
  if (!score) return UNRECORDED;
  if (score.noReturn) return NO_RETURN;
  if (score.gross === null) return UNRECORDED;
  return { kind: 'numeric', gross: score.gross };
}
