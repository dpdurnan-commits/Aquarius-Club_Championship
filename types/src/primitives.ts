/**
 * Shared domain primitives and constants for the Club Championship Scoring tool.
 *
 * These types capture the bounded, well-defined value ranges from the
 * requirements glossary so that the scoring, ranking, and cut logic can be
 * expressed with compile-time safety. Runtime validation still lives in the
 * services (validate-reject-retain); these types describe intent and shape.
 */

/** The two competition rounds. Each Day is 18 holes. (Requirement 7.2) */
export type Day = 1 | 2;

/** Ordinal identifying one of exactly 18 holes, 1..18. (Requirement 1.1) */
export type HoleOrdinal =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;

/** Par for a hole, an integer 3..6. Nullable until configured. */
export type Par = 3 | 4 | 5 | 6;

/**
 * Stroke index of a hole, 1 (hardest) .. 18 (easiest), unique across holes.
 * Same numeric domain as HoleOrdinal but a distinct semantic concept.
 */
export type StrokeIndex =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;

/**
 * Playing handicap: whole number of handicap strokes over a round, 0..36.
 * Entered per player per day. (Requirements 2.5, 4)
 *
 * The full 0..36 range is not enumerated as a literal union; it is a branded
 * integer validated at the service boundary.
 */
export type PlayingHandicap = number;

/** Gross strokes taken on a hole, an integer 1..20. (Requirement 7.3) */
export type Gross = number;

/** The number of holes on each day, and total holes over the championship. */
export const HOLES_PER_DAY = 18 as const;

/** All hole ordinals in ascending order, 1..18. */
export const HOLE_ORDINALS: readonly HoleOrdinal[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
] as const;

/** The two days. */
export const DAYS: readonly Day[] = [1, 2] as const;

/** Inclusive bounds for par. (Requirement 1.2) */
export const PAR_MIN = 3 as const;
export const PAR_MAX = 6 as const;

/** Inclusive bounds for stroke index. (Requirement 1.3) */
export const STROKE_INDEX_MIN = 1 as const;
export const STROKE_INDEX_MAX = 18 as const;

/** Inclusive bounds for playing handicap. (Requirement 2.5) */
export const HANDICAP_MIN = 0 as const;
export const HANDICAP_MAX = 36 as const;

/** Inclusive bounds for gross strokes on a hole. (Requirement 7.3) */
export const GROSS_MIN = 1 as const;
export const GROSS_MAX = 20 as const;

/** Inclusive bounds for player name length. (Requirement 2.1) */
export const PLAYER_NAME_MIN_LENGTH = 1 as const;
export const PLAYER_NAME_MAX_LENGTH = 100 as const;

/** Stableford points awarded on a hole, 0..5. (Requirement 5) */
export type StablefordPoints = 0 | 1 | 2 | 3 | 4 | 5;
