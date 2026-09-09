/**
 * Render-ready view snapshot shapes produced by the ScoresDisplayAssembler and
 * consumed by the (purely presentational) frontend. All derived values —
 * Stableford points, aggregates, positions, relative-to-par, CUT/NR handling —
 * are computed server-side and delivered as pre-formatted strings/values so the
 * client does no scoring math. (Requirements 8, 9)
 */

import type { HoleOrdinal, Par, StrokeIndex, Day } from './primitives.js';

/**
 * One header column describing a hole. Par/strokeIndex are null when the course
 * is not yet fully configured. (Requirements 8.1, 9.1)
 */
export interface HoleHeaderCell {
  readonly ordinal: HoleOrdinal;
  readonly par: Par | null;
  readonly strokeIndex: StrokeIndex | null;
}

/** The shared 18-column header, in ascending ordinal order. */
export type ViewHeader = readonly HoleHeaderCell[];

/**
 * A per-hole score cell as rendered:
 *  - numeric: display "gross (points)" (text carries the formatted string)
 *  - NR:      display "NR"
 *  - empty:   unrecorded, display nothing
 * The structured fields let the client style cells without re-parsing text.
 * (Requirements 8.3, 8.4, 8.11, 9.6, 9.7, 9.11)
 */
export type HoleCell =
  | { readonly kind: 'empty'; readonly text: '' }
  | { readonly kind: 'numeric'; readonly gross: number; readonly points: number; readonly text: string }
  | { readonly kind: 'NR'; readonly text: 'NR' };

/**
 * An aggregate cell rendered as "total (position)", or "NR (NR)" when the
 * player has an NR on the relevant day. (Requirements 8.6, 8.8, 8.12, 8.13)
 */
export interface AggregateCell {
  /** Formatted display text, e.g. "84 (3)" or "NR (NR)". */
  readonly text: string;
  /** Numeric total; the Stableford total remains meaningful even under NR. */
  readonly total: number;
  /** Competition position, or null when unranked (NR). */
  readonly position: number | null;
  /** True when NR handling applies to this aggregate. */
  readonly isNR: boolean;
}

/**
 * A relative-to-par cell: signed "+n"/"-n"/"0", "NR" when any NR on the
 * relevant day(s), or empty when there are no completed holes.
 * (Requirements 8.9, 8.10, 8.14, 9.10, 9.15)
 */
export interface RelativeToParCell {
  /** "+n" / "-n" / "0" / "NR" / "". */
  readonly text: string;
  /** Numeric value when applicable; null when NR or no completed holes. */
  readonly value: number | null;
  readonly isNR: boolean;
}

/** A single player row on the Day 1 view. (Requirement 8.2) */
export interface Day1PlayerRow {
  readonly playerId: string;
  readonly name: string;
  readonly handicap: number | null;
  /** 18 per-hole cells in ascending ordinal order. */
  readonly holes: readonly HoleCell[];
  /** "total (position)" scratch aggregate. (Requirements 8.5, 8.6, 8.12) */
  readonly aggregateStrokes: AggregateCell;
  /** "total (position)" Stableford aggregate. (Requirements 8.7, 8.8, 8.13, 8.15) */
  readonly aggregateStableford: AggregateCell;
  /** Signed relative-to-par / "NR" / empty. (Requirements 8.9, 8.10, 8.14) */
  readonly relativeToPar: RelativeToParCell;
}

/** The complete Day 1 view snapshot. (Requirement 8) */
export interface Day1View {
  readonly day: 1;
  readonly header: ViewHeader;
  readonly rows: readonly Day1PlayerRow[];
}

/**
 * The combined-strokes cell on Day 2: "day1total (day2total)" with NR
 * substitution per side. (Requirements 9.8, 9.12, 9.13, 9.14)
 */
export interface CombinedStrokesCell {
  /** e.g. "84 (79)", "NR (79)", "84 (NR)", "NR (NR)". */
  readonly text: string;
  readonly day1Total: number | null;
  readonly day2Total: number | null;
  readonly day1IsNR: boolean;
  readonly day2IsNR: boolean;
  /**
   * The single running total of Day 1 + Day 2 gross strokes, for the display's
   * "Total strokes" column. Null when either day is NR (the sum is not a clean
   * total), in which case {@link combinedTotalText} renders "NR".
   */
  readonly combinedTotal: number | null;
  /** Display text for the combined total: the number, or "NR". */
  readonly combinedTotalText: string;
}

/**
 * The combined-Stableford cell on Day 2: "total36 (day2total)". total36 sums
 * numeric holes across both days regardless of NR. (Requirements 9.9, 9.16)
 */
export interface CombinedStablefordCell {
  /** e.g. "72 (34)". */
  readonly text: string;
  readonly total36: number;
  readonly day2Total: number;
  /**
   * The player's ranked position across the whole (non-cut) field by combined
   * Day 1 + Day 2 Stableford points (`total36`), highest total ranked 1, using
   * standard competition ranking (ties share a position). Shown in brackets in
   * the display's "Total Stableford" column, e.g. "72 (3)".
   */
  readonly total36Position: number;
}

/** A single player row on the Day 2 view. (Requirement 9.2) */
export interface Day2PlayerRow {
  readonly playerId: string;
  readonly name: string;
  readonly handicap: number | null;
  readonly cut: boolean;
  /** Day 1 aggregate strokes shown in a dedicated column. (Requirement 9.5) */
  readonly day1AggregateStrokes: number | null;
  /**
   * 18 per-hole Day 2 cells. Empty for CUT players (no Day 2 scores shown).
   * (Requirements 9.6, 9.7, 9.11, 9.18)
   */
  readonly holes: readonly HoleCell[];
  /** "day1total (day2total)". Absent (null) for CUT players. (Requirement 9.8) */
  readonly combinedStrokes: CombinedStrokesCell | null;
  /** "total36 (day2total)". Absent (null) for CUT players. (Requirement 9.9) */
  readonly combinedStableford: CombinedStablefordCell | null;
  /** Cumulative relative-to-par over completed Day 1+2 holes. (Requirement 9.10) */
  readonly relativeToPar: RelativeToParCell;
}

/** The complete Day 2 view snapshot. (Requirement 9) */
export interface Day2View {
  readonly day: 2;
  readonly header: ViewHeader;
  /** Rows already ordered per Requirements 9.3, 9.4 (non-CUT first, CUT last). */
  readonly rows: readonly Day2PlayerRow[];
}

/** Union of the day-specific views, discriminated by `day`. */
export type ScoresView = Day1View | Day2View;

/** Maps a Day value to its corresponding view type. */
export type ViewForDay<D extends Day> = D extends 1 ? Day1View : Day2View;
