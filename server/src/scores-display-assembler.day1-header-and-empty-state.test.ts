import { describe, it, expect } from 'vitest';
import {
  HOLE_ORDINALS,
  type Day,
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
 * Concrete unit tests for ScoresDisplayAssembler.buildDay1View — Day 1 header
 * content/order and the no-completed-holes empty state.
 *
 * Validates: Requirements 8.1, 8.2, 8.10
 *
 * These are example-based unit tests (the field-wide/format properties are
 * covered by the sibling property tests). They drive the real assembler over a
 * tiny in-memory repository stub exposing only the three read methods
 * `buildDay1View` uses (`getHoles`, `getPlayers`, `getScoresForDay`); Day 2
 * scores are never requested, so `getScoresForDay(2)` returns an empty list.
 */
describe('ScoresDisplayAssembler.buildDay1View — header and empty state', () => {
  /**
   * An assembler whose only persistence dependency is the three read methods
   * `buildDay1View` calls. Rows are deep-copied so the assembler cannot mutate
   * the fixtures.
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
   * A fully configured 18-hole course. Par follows a fixed 4/3/5/... rotation
   * and stroke index is the odd ordinals ascending then the even ordinals, so
   * each hole has a distinct par/stroke-index pairing to assert against.
   */
  const configuredCourse = (): Hole[] => {
    const pars = [4, 3, 5] as const;
    // Stroke index 1..18: a fixed permutation so header order can be checked.
    const strokeIndices = [
      10, 4, 14, 2, 16, 8, 12, 6, 18, 1, 11, 3, 15, 7, 13, 5, 9, 17,
    ];
    return HOLE_ORDINALS.map((ordinal, i) => ({
      ordinal,
      par: pars[i % 3] as Par,
      strokeIndex: strokeIndices[i] as unknown as StrokeIndex,
    }));
  };

  it('renders an 18-column header of ordinal/par/stroke-index in ascending ordinal order (Requirement 8.1)', () => {
    const holes = configuredCourse();
    const view = assemblerOver(holes, [], []).buildDay1View();

    expect(view.day).toBe(1);
    expect(view.header).toHaveLength(18);

    // Ordinals appear exactly 1..18 in ascending order.
    expect(view.header.map((c) => c.ordinal)).toEqual([...HOLE_ORDINALS]);

    // Each header column carries the configured par and stroke index for the
    // hole at that ordinal.
    const byOrdinal = new Map<HoleOrdinal, Hole>(
      holes.map((h) => [h.ordinal, h]),
    );
    for (const cell of view.header) {
      const hole = byOrdinal.get(cell.ordinal)!;
      expect(cell.par).toBe(hole.par);
      expect(cell.strokeIndex).toBe(hole.strokeIndex);
    }
  });

  it('renders null par and stroke index in the header when the course is not yet configured (Requirement 8.1)', () => {
    const holes: Hole[] = HOLE_ORDINALS.map((ordinal) => ({
      ordinal,
      par: null,
      strokeIndex: null,
    }));

    const view = assemblerOver(holes, [], []).buildDay1View();

    expect(view.header.map((c) => c.ordinal)).toEqual([...HOLE_ORDINALS]);
    for (const cell of view.header) {
      expect(cell.par).toBeNull();
      expect(cell.strokeIndex).toBeNull();
    }
  });

  it('renders one row per player with the player name and Day 1 playing handicap (Requirement 8.2)', () => {
    const holes = configuredCourse();
    const players: Player[] = [
      {
        id: 'p1',
        name: 'Alice',
        handicapDay1: 8,
        handicapDay2: 9,
        cut: false,
      },
      {
        id: 'p2',
        name: 'Bob',
        handicapDay1: 24,
        handicapDay2: 22,
        cut: false,
      },
      {
        id: 'p3',
        name: 'Carol',
        handicapDay1: null,
        handicapDay2: null,
        cut: false,
      },
    ];

    const view = assemblerOver(holes, players, []).buildDay1View();

    // One row per player. With no scores entered, every player is in the
    // "unscored" group, so the leaderboard sort preserves the repository's
    // alphabetical order (Alice, Bob, Carol).
    expect(view.rows).toHaveLength(players.length);
    expect(view.rows.map((r) => r.playerId)).toEqual(['p1', 'p2', 'p3']);

    // Each row shows the player name and the Day 1 handicap (not Day 2), with
    // a missing handicap surfaced as null.
    expect(view.rows[0]).toMatchObject({ name: 'Alice', handicap: 8 });
    expect(view.rows[1]).toMatchObject({ name: 'Bob', handicap: 24 });
    expect(view.rows[2]).toMatchObject({ name: 'Carol', handicap: null });
  });

  it('renders the no-completed-holes empty state as 0 / 0 / empty (Requirement 8.10)', () => {
    const holes = configuredCourse();
    const player: Player = {
      id: 'p1',
      name: 'Dana',
      handicapDay1: 12,
      handicapDay2: 12,
      cut: false,
    };

    // No Day 1 scores at all → no completed holes for the player.
    const view = assemblerOver(holes, [player], []).buildDay1View();
    const row = view.rows.find((r) => r.playerId === 'p1')!;
    expect(row).toBeDefined();

    // 8.10: Aggregate_Strokes shows 0 (not NR — the player has no NR).
    expect(row.aggregateStrokes.total).toBe(0);
    expect(row.aggregateStrokes.isNR).toBe(false);

    // 8.10: Aggregate_Stableford shows 0.
    expect(row.aggregateStableford.total).toBe(0);
    expect(row.aggregateStableford.isNR).toBe(false);

    // 8.10: Relative_To_Par cell is empty.
    expect(row.relativeToPar.text).toBe('');
    expect(row.relativeToPar.value).toBeNull();
    expect(row.relativeToPar.isNR).toBe(false);
  });

  it('applies the no-completed-holes empty state per player, independent of others (Requirement 8.10)', () => {
    const holes = configuredCourse();
    const players: Player[] = [
      { id: 'p1', name: 'Empty', handicapDay1: 10, handicapDay2: 10, cut: false },
      { id: 'p2', name: 'Played', handicapDay1: 10, handicapDay2: 10, cut: false },
    ];

    // Only p2 has a completed Day 1 hole; p1 has none.
    const scores: Score[] = [
      { playerId: 'p2', day: 1, ordinal: 1 as HoleOrdinal, gross: 5, noReturn: false },
    ];

    const view = assemblerOver(holes, players, scores).buildDay1View();

    const empty = view.rows.find((r) => r.playerId === 'p1')!;
    expect(empty.aggregateStrokes.total).toBe(0);
    expect(empty.aggregateStableford.total).toBe(0);
    expect(empty.relativeToPar.text).toBe('');
    expect(empty.relativeToPar.value).toBeNull();

    // The player with a completed hole is not treated as empty.
    const played = view.rows.find((r) => r.playerId === 'p2')!;
    expect(played.aggregateStrokes.total).toBeGreaterThan(0);
    expect(played.relativeToPar.text).not.toBe('');
  });
});
