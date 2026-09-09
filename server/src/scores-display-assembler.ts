/**
 * ScoresDisplayAssembler — builds render-ready view snapshots (Requirements 8, 9).
 *
 * The client is purely presentational: every derived value (Stableford points,
 * aggregates, competition positions, relative-to-par, and NR handling) is
 * computed server-side here and delivered as pre-formatted strings plus the
 * structured fields the frontend uses to style cells. This module owns no
 * scoring math of its own — it reuses the pure domain logic:
 *  - StablefordCalculator (`allocateHandicapStrokes`, `stablefordForHole`) for
 *    per-hole handicap strokes and points.
 *  - day-aggregation helpers (`completedHoles`, `aggregateStrokes`,
 *    `aggregateStableford`, `relativeToPar`, `hasNROnDay`) for per-day rollups.
 *  - RankingAndCutService (`rankScratch`, `rankStableford`) for competition
 *    positions.
 *
 * Task 10.1 implements `buildDay1View`; task 10.7 implements `buildDay2View`.
 */

import {
  HOLE_ORDINALS,
  cellStateOf,
  isOk,
  type Hole,
  type HoleOrdinal,
  type Player,
  type Score,
  type AggregateCell,
  type CombinedStablefordCell,
  type CombinedStrokesCell,
  type Day1PlayerRow,
  type Day1View,
  type Day2PlayerRow,
  type Day2View,
  type HoleCell,
  type RelativeToParCell,
  type ViewHeader,
} from '@ccs/types';
import {
  allocateHandicapStrokes,
  stablefordForHole,
  type HandicapStrokesByHole,
  type StrokeIndexByHole,
} from './stableford-calculator.js';
import {
  aggregateStableford,
  aggregateStrokes,
  completedHoles,
  hasNROnDay,
  relativeToPar,
  type DayAggregationInput,
} from './day-aggregation.js';
import {
  rankScratch,
  rankStableford,
  type CompetitionPosition,
  type PositionsByPlayer,
  type RankablePlayer,
} from './ranking-and-cut-service.js';
import type { Repository } from './repository.js';

/** Day 1 is the round the Day 1 view is assembled from. */
const DAY_ONE = 1 as const;

/** Day 2 is the round the Day 2 view is assembled from. */
const DAY_TWO = 2 as const;

/** The NR token rendered in place of a numeric total or position. (8.11–8.14) */
const NR_TEXT = 'NR' as const;

/**
 * Assembles the render-ready display snapshots from the persisted Score, Hole,
 * and Player rows. It reads through the {@link Repository} and delegates every
 * derivation to the pure domain helpers, so it never re-derives scoring rules.
 */
export class ScoresDisplayAssembler {
  private readonly repository: Repository;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  /**
   * Build the complete Day 1 view snapshot. (Requirement 8)
   *
   * The snapshot carries:
   *  - a header of ordinal/par/stroke-index for holes 1..18 in ascending
   *    ordinal order (8.1);
   *  - one row per player with the player name and Day 1 playing handicap (8.2),
   *    18 per-hole cells ("gross (points)" / "NR" / empty) (8.3, 8.4, 8.11),
   *    an aggregate-strokes cell "total (position)" (or "NR (NR)") (8.5, 8.6,
   *    8.12), an aggregate-Stableford cell "total (position)" (position "NR"
   *    under NR) (8.7, 8.8, 8.13, 8.15), and a signed relative-to-par cell
   *    ("+n"/"-n"/"0", "NR", or empty) (8.9, 8.10, 8.14).
   *
   * Competition positions come from ranking every player's Day 1 aggregates, so
   * a player's bracketed position is consistent with the whole field. Players
   * are listed in the repository's stable order (by name).
   *
   * @returns The assembled {@link Day1View} snapshot.
   */
  buildDay1View(): Day1View {
    const holes = this.repository.getHoles();
    const players = this.repository.getPlayers();
    const day1Scores = this.repository.getScoresForDay(DAY_ONE);

    const header = buildHeader(holes);

    // Rank the whole field once so each row's bracketed position is consistent
    // with every other player. (8.6, 8.8)
    const { scratchPositions, stablefordPositions } = rankField(
      players,
      day1Scores,
      holes,
    );

    const built = players.map((player) =>
      this.buildDay1Row(
        player,
        day1Scores,
        holes,
        scratchPositions.get(player.id) ?? null,
        stablefordPositions.get(player.id) ?? null,
      ),
    );

    const rows = orderDay1Rows(built);

    return { day: DAY_ONE, header, rows };
  }

  /** Assemble a single Day 1 player row plus its leaderboard ordering metadata. */
  private buildDay1Row(
    player: Player,
    day1Scores: readonly Score[],
    holes: readonly Hole[],
    scratchPosition: CompetitionPosition,
    stablefordPosition: CompetitionPosition,
  ): Day1Row {
    const aggregation: DayAggregationInput = {
      player,
      day: DAY_ONE,
      scores: day1Scores,
      holes,
    };

    const nr = hasNROnDay(aggregation);
    const completed = completedHoles(aggregation);
    const hasCompletedHoles = completed.length > 0;
    const rtp = relativeToPar(aggregation);

    return {
      row: {
        playerId: player.id,
        name: player.name,
        handicap: player.handicapDay1 ?? null,
        holes: buildHoleCells(aggregation),
        aggregateStrokes: buildStrokesAggregate(
          aggregateStrokes(aggregation),
          scratchPosition,
          nr,
        ),
        aggregateStableford: buildStablefordAggregate(
          aggregateStableford(aggregation),
          stablefordPosition,
          nr,
        ),
        relativeToPar: buildRelativeToPar(rtp, nr, hasCompletedHoles),
      },
      // Rows are ordered by score-to-par ascending; players with at least one
      // completed numeric hole rank ahead of NR and unscored players.
      relativeToPar: rtp,
      hasScore: hasCompletedHoles,
      isNR: nr,
    };
  }

  /**
   * Build the complete Day 2 view snapshot. (Requirement 9)
   *
   * The snapshot carries the shared 18-column header (9.1) and one row per
   * player (9.2). Rows are ordered so players without CUT status appear first,
   * ascending by their combined (Day 1 + Day 2) relative-to-par with ties
   * broken alphabetically by name, and CUT players appear last in alphabetical
   * order (9.3, 9.4). The repository already returns players alphabetically, so
   * a stable sort preserves the alphabetical tie-break and CUT ordering.
   *
   * Each row shows the Day 2 playing handicap (9.2), the Day 1 aggregate strokes
   * in a dedicated column (9.5), 18 per-hole Day 2 cells (9.6, 9.7, 9.11), a
   * combined-strokes cell "day1total (day2total)" with per-side NR substitution
   * (9.8, 9.12–9.14), a combined-Stableford cell "total36 (day2total)" where
   * total36 sums points over numeric holes across both days regardless of NR
   * (9.9, 9.16), and a cumulative relative-to-par cell over the completed
   * Day 1+Day 2 holes, rendered "NR" when the player has any NR on either day
   * (9.10, 9.15). CUT players show "CUT" against their name and have every
   * Day 2 hole score and aggregate suppressed (9.17, 9.18).
   *
   * @returns The assembled {@link Day2View} snapshot.
   */
  buildDay2View(): Day2View {
    const holes = this.repository.getHoles();
    const players = this.repository.getPlayers();
    const day1Scores = this.repository.getScoresForDay(DAY_ONE);
    const day2Scores = this.repository.getScoresForDay(DAY_TWO);

    const header = buildHeader(holes);

    const rows = players.map((player) =>
      this.buildDay2Row(player, day1Scores, day2Scores, holes),
    );

    // Rank the (non-cut) field by combined Day 1 + Day 2 Stableford (`total36`),
    // highest total ranked 1, using the same standard-competition ranking (ties
    // share a position) as the Day 1 competitions. total36 is always a valid
    // number, so no player is excluded for NR here. Cut players are omitted:
    // they have no combined cell. The resulting positions are written back into
    // each row's combined-Stableford cell for the display's bracketed rank.
    const rankable: RankablePlayer[] = rows
      .filter((r) => r.row.combinedStableford !== null)
      .map((r) => ({
        playerId: r.row.playerId,
        value: r.row.combinedStableford!.total36,
        hasNRDay1: false,
      }));
    const total36Positions = rankStableford(rankable);

    const rankedRows = rows.map((r) => {
      const cell = r.row.combinedStableford;
      if (cell === null) return r;
      const position = total36Positions.get(r.row.playerId) ?? 0;
      return {
        ...r,
        row: {
          ...r.row,
          combinedStableford: { ...cell, total36Position: position ?? 0 },
        },
      };
    });

    const ordered = orderDay2Rows(rankedRows);

    return { day: DAY_TWO, header, rows: ordered };
  }

  /** Assemble a single Day 2 player row. */
  private buildDay2Row(
    player: Player,
    day1Scores: readonly Score[],
    day2Scores: readonly Score[],
    holes: readonly Hole[],
  ): Day2Row {
    const day1Input: DayAggregationInput = {
      player,
      day: DAY_ONE,
      scores: day1Scores,
      holes,
    };
    const day2Input: DayAggregationInput = {
      player,
      day: DAY_TWO,
      scores: day2Scores,
      holes,
    };

    const day1NR = hasNROnDay(day1Input);
    const day2NR = hasNROnDay(day2Input);
    const anyNR = day1NR || day2NR;

    const day1Strokes = aggregateStrokes(day1Input);
    const day2Strokes = aggregateStrokes(day2Input);

    // total36 sums Stableford points over numeric holes across BOTH days,
    // regardless of NR on either day. Each per-day aggregate already excludes
    // NR/unrecorded holes. (9.16)
    const total36 = aggregateStableford(day1Input) + aggregateStableford(day2Input);
    const day2Stableford = aggregateStableford(day2Input);

    // Cumulative relative-to-par spans both days: each per-day relativeToPar is
    // (aggregate strokes − par of that day's completed holes), so summing them
    // yields combined gross over completed holes minus the par of those holes.
    // (9.10)
    const cumulativeRelativeToPar =
      relativeToPar(day1Input) + relativeToPar(day2Input);
    const hasCompletedHoles =
      completedHoles(day1Input).length + completedHoles(day2Input).length > 0;

    if (player.cut) {
      // CUT players show "CUT" against the name with no Day 2 hole scores and no
      // Day 2 aggregates/totals. The Day 1 aggregate column context is retained.
      // (9.17, 9.18)
      return {
        row: {
          playerId: player.id,
          name: player.name,
          handicap: player.handicapDay2 ?? null,
          cut: true,
          day1AggregateStrokes: day1NR ? null : day1Strokes,
          holes: emptyHoleCells(),
          combinedStrokes: null,
          combinedStableford: null,
          relativeToPar: { text: '', value: null, isNR: false },
        },
        sortKey: cumulativeRelativeToPar,
        cut: true,
      };
    }

    return {
      row: {
        playerId: player.id,
        name: player.name,
        handicap: player.handicapDay2 ?? null,
        cut: false,
        day1AggregateStrokes: day1NR ? null : day1Strokes,
        holes: buildHoleCells(day2Input),
        combinedStrokes: buildCombinedStrokes(
          day1Strokes,
          day2Strokes,
          day1NR,
          day2NR,
        ),
        // Position is filled in by buildDay2View once the whole field's
        // combined-Stableford totals are known; 0 is a temporary placeholder.
        combinedStableford: buildCombinedStableford(total36, day2Stableford, 0),
        relativeToPar: buildRelativeToPar(
          cumulativeRelativeToPar,
          anyNR,
          hasCompletedHoles,
        ),
      },
      sortKey: cumulativeRelativeToPar,
      cut: false,
    };
  }
}

/**
 * Build the shared 18-column header (ordinal / par / stroke index) in ascending
 * ordinal order. Par and stroke index are null where the course is not yet
 * configured. (Requirement 8.1)
 */
function buildHeader(holes: readonly Hole[]): ViewHeader {
  const byOrdinal = new Map<HoleOrdinal, Hole>();
  for (const hole of holes) {
    byOrdinal.set(hole.ordinal, hole);
  }
  return HOLE_ORDINALS.map((ordinal) => {
    const hole = byOrdinal.get(ordinal);
    return {
      ordinal,
      par: hole?.par ?? null,
      strokeIndex: hole?.strokeIndex ?? null,
    };
  });
}

/**
 * Rank the whole field for both Day 1 competitions from each player's
 * aggregates, reusing the day-aggregation helpers and RankingAndCutService.
 * NR players are excluded and receive a null position. (Requirements 6, 8.6, 8.8)
 */
function rankField(
  players: readonly Player[],
  day1Scores: readonly Score[],
  holes: readonly Hole[],
): { scratchPositions: PositionsByPlayer; stablefordPositions: PositionsByPlayer } {
  const scratchInput: RankablePlayer[] = [];
  const stablefordInput: RankablePlayer[] = [];

  for (const player of players) {
    const aggregation: DayAggregationInput = {
      player,
      day: DAY_ONE,
      scores: day1Scores,
      holes,
    };
    const nr = hasNROnDay(aggregation);
    scratchInput.push({
      playerId: player.id,
      value: aggregateStrokes(aggregation),
      hasNRDay1: nr,
    });
    stablefordInput.push({
      playerId: player.id,
      value: aggregateStableford(aggregation),
      hasNRDay1: nr,
    });
  }

  return {
    scratchPositions: rankScratch(scratchInput),
    stablefordPositions: rankStableford(stablefordInput),
  };
}

/**
 * Build the 18 per-hole cells for a day, in ascending ordinal order:
 *  - numeric hole → "gross (points)" (8.3),
 *  - NR hole → "NR" (8.11),
 *  - unrecorded hole → empty cell (8.4).
 *
 * Points reuse the StablefordCalculator with the player's handicap allocation
 * for the day. When the course is incomplete (no allocation, or a hole with no
 * par) points cannot be computed; the cell falls back to showing "gross (0)"
 * so the recorded gross is never hidden.
 */
function buildHoleCells(input: DayAggregationInput): readonly HoleCell[] {
  const byOrdinalScore = new Map<HoleOrdinal, Score>();
  for (const score of input.scores) {
    if (score.playerId === input.player.id && score.day === input.day) {
      byOrdinalScore.set(score.ordinal, score);
    }
  }

  const holesByOrdinal = new Map<HoleOrdinal, Hole>();
  for (const hole of input.holes) {
    holesByOrdinal.set(hole.ordinal, hole);
  }

  const handicapStrokes = resolveHandicapStrokes(input);

  return HOLE_ORDINALS.map((ordinal) => {
    const state = cellStateOf(byOrdinalScore.get(ordinal));

    if (state.kind === 'unrecorded') {
      return { kind: 'empty', text: '' } as HoleCell;
    }
    if (state.kind === 'NR') {
      return { kind: 'NR', text: NR_TEXT } as HoleCell;
    }

    // Numeric cell: compute points where par and allocation are available;
    // otherwise contribute 0 points but always keep the recorded gross visible.
    const par = holesByOrdinal.get(ordinal)?.par ?? null;
    const strokesOnHole = handicapStrokes?.get(ordinal) ?? 0;
    let points = 0;
    if (par !== null) {
      const computed = stablefordForHole(state, par, strokesOnHole);
      if (isOk(computed)) {
        points = computed.value;
      }
    }

    return {
      kind: 'numeric',
      gross: state.gross,
      points,
      text: `${state.gross} (${points})`,
    } as HoleCell;
  });
}

/**
 * Resolve the per-hole handicap stroke allocation for the day's playing
 * handicap, or null when withheld (incomplete course / missing handicap), in
 * which case every hole is treated as receiving 0 handicap strokes.
 * (Mirrors the day-aggregation module's private resolver; Requirement 4.4.)
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
 * Format the position for a bracketed aggregate cell: the numeric position, or
 * "NR" when the player is unranked (has a Day 1 NR / null position). (8.6, 8.12)
 */
function formatPosition(position: CompetitionPosition, nr: boolean): string {
  if (nr || position === null) {
    return NR_TEXT;
  }
  return String(position);
}

/**
 * Build the aggregate-strokes cell "total (position)"; under NR it renders
 * "NR (NR)" with a null position and the numeric total suppressed.
 * (Requirements 8.5, 8.6, 8.12; also covers the no-completed-holes total of 0
 * from `aggregateStrokes`, 8.10.)
 */
function buildStrokesAggregate(
  total: number,
  position: CompetitionPosition,
  nr: boolean,
): AggregateCell {
  if (nr) {
    return {
      text: `${NR_TEXT} (${NR_TEXT})`,
      total,
      position: null,
      isNR: true,
    };
  }
  return {
    text: `${total} (${formatPosition(position, false)})`,
    total,
    position,
    isNR: false,
  };
}

/**
 * Build the aggregate-Stableford cell "total (position)". The numeric total is
 * always the sum of points over the day's numeric holes (NR/unrecorded
 * contribute 0), even under NR; only the bracketed position becomes "NR".
 * (Requirements 8.7, 8.8, 8.13, 8.15; no-completed-holes total of 0 is 8.10.)
 */
function buildStablefordAggregate(
  total: number,
  position: CompetitionPosition,
  nr: boolean,
): AggregateCell {
  return {
    text: `${total} (${formatPosition(position, nr)})`,
    total,
    position: nr ? null : position,
    isNR: nr,
  };
}

/**
 * Build the relative-to-par cell:
 *  - "NR" when the player has any Day 1 NR (8.14);
 *  - empty when there are no completed holes (8.10);
 *  - otherwise a signed value: "+n" (> 0), "-n" (< 0), or "0" (8.9).
 */
function buildRelativeToPar(
  value: number,
  nr: boolean,
  hasCompletedHoles: boolean,
): RelativeToParCell {
  if (nr) {
    return { text: NR_TEXT, value: null, isNR: true };
  }
  if (!hasCompletedHoles) {
    return { text: '', value: null, isNR: false };
  }
  return { text: formatSigned(value), value, isNR: false };
}

/** Format a relative-to-par value as "+n" / "-n" / "0". (Requirement 8.9) */
function formatSigned(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return String(value);
  return '0';
}

/**
 * A Day 1 row paired with the metadata used to order the leaderboard: the Day 1
 * relative-to-par (the sort key), whether the player has at least one completed
 * numeric hole, and whether they have an NR on the day.
 */
interface Day1Row {
  readonly row: Day1PlayerRow;
  readonly relativeToPar: number;
  readonly hasScore: boolean;
  readonly isNR: boolean;
}

/**
 * Order the Day 1 rows as a live leaderboard:
 *  - players with at least one completed numeric hole (and no NR) come first,
 *    ascending by relative-to-par (lowest / best score to par first);
 *  - NR players come next (they have scores but no rankable to-par total);
 *  - players with no scores yet come last.
 * Ties within a group keep the incoming order, which is alphabetical by name
 * (the repository returns players by name), so a stable sort is sufficient.
 */
function orderDay1Rows(rows: readonly Day1Row[]): readonly Day1PlayerRow[] {
  const rank = (r: Day1Row): number => {
    if (r.hasScore && !r.isNR) return 0; // scored + rankable
    if (r.isNR) return 1; // has an NR
    return 2; // no scores entered yet
  };

  return [...rows]
    .sort((a, b) => {
      const groupDelta = rank(a) - rank(b);
      if (groupDelta !== 0) return groupDelta;
      // Within the scored group, order by score-to-par ascending. Other groups
      // keep the stable alphabetical order.
      if (rank(a) === 0) return a.relativeToPar - b.relativeToPar;
      return 0;
    })
    .map((r) => r.row);
}

/**
 * A Day 2 row paired with the ordering metadata used to sort the field: the
 * cumulative (Day 1 + Day 2) relative-to-par used to order non-CUT rows, and
 * whether the player has CUT status (CUT rows are placed after all others).
 */
interface Day2Row {
  readonly row: Day2PlayerRow;
  readonly sortKey: number;
  readonly cut: boolean;
}

/**
 * Order the Day 2 rows: players without CUT status first, ascending by their
 * cumulative relative-to-par with ties broken alphabetically by name; CUT
 * players last, alphabetically by name. The repository returns players in
 * alphabetical order, so a stable sort preserves that order for both the
 * within-tie ordering and the CUT block. (Requirements 9.3, 9.4)
 */
function orderDay2Rows(rows: readonly Day2Row[]): readonly Day2PlayerRow[] {
  const nonCut = rows.filter((r) => !r.cut);
  const cut = rows.filter((r) => r.cut);

  // Stable sort by relative-to-par ascending; equal keys keep the incoming
  // alphabetical order (the repository orders players by name). (9.3)
  const orderedNonCut = [...nonCut].sort((a, b) => a.sortKey - b.sortKey);

  // CUT rows are already alphabetical from the repository order. (9.4)
  return [...orderedNonCut, ...cut].map((r) => r.row);
}

/** Eighteen empty per-hole cells, used to suppress a CUT player's Day 2 scores. */
function emptyHoleCells(): readonly HoleCell[] {
  return HOLE_ORDINALS.map(() => ({ kind: 'empty', text: '' }) as HoleCell);
}

/**
 * Build the combined-strokes cell "day1total (day2total)" with per-side NR
 * substitution: the Day 1 portion becomes "NR" when the player has a Day 1 NR,
 * the bracketed Day 2 portion becomes "NR" under a Day 2 NR, and both become
 * "NR" when NR on both days. (Requirements 9.8, 9.12, 9.13, 9.14)
 */
function buildCombinedStrokes(
  day1Total: number,
  day2Total: number,
  day1NR: boolean,
  day2NR: boolean,
): CombinedStrokesCell {
  const day1Text = day1NR ? NR_TEXT : String(day1Total);
  const day2Text = day2NR ? NR_TEXT : String(day2Total);
  // The running combined total is only a clean number when neither day is NR;
  // if either day is a No_Return, the total is not meaningful and renders "NR".
  const anyNR = day1NR || day2NR;
  const combinedTotal = anyNR ? null : day1Total + day2Total;
  return {
    text: `${day1Text} (${day2Text})`,
    day1Total: day1NR ? null : day1Total,
    day2Total: day2NR ? null : day2Total,
    day1IsNR: day1NR,
    day2IsNR: day2NR,
    combinedTotal,
    combinedTotalText: combinedTotal === null ? NR_TEXT : String(combinedTotal),
  };
}

/**
 * Build the combined-Stableford cell "total36 (day2total)". total36 is the sum
 * of Stableford points over numeric holes across both days (NR/unrecorded holes
 * contribute 0), regardless of any NR on either day, and day2Total is the Day 2
 * aggregate Stableford. (Requirements 9.9, 9.16)
 */
function buildCombinedStableford(
  total36: number,
  day2Total: number,
  total36Position: number,
): CombinedStablefordCell {
  return {
    text: `${total36} (${day2Total})`,
    total36,
    day2Total,
    total36Position,
  };
}
