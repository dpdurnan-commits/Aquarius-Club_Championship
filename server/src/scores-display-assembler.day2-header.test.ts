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
 * Concrete unit tests for ScoresDisplayAssembler.buildDay2View — Day 2 header
 * content/order and one-row-per-player with the Day 2 playing handicap.
 *
 * Validates: Requirements 9.1, 9.2
 *
 * These are example-based unit tests (the field-wide/format properties are
 * covered by the sibling property tests). They drive the real assembler over a
 * tiny in-memory repository stub exposing only the three read methods
 * `buildDay2View` uses (`getHoles`, `getPlayers`, `getScoresForDay`). Both days
 * are served from the stub; rows are deep-copied so the assembler cannot mutate
 * the fixtures.
 */
describe('ScoresDisplayAssembler.buildDay2View — header and player rows', () => {
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
        (day === 1 ? day1Scores : day2Scores).map((s) => ({ ...s })),
    };
    return new ScoresDisplayAssembler(source as unknown as Repository);
  };

  /**
   * A fully configured 18-hole course. Par follows a fixed 4/3/5 rotation and
   * stroke index is a fixed 1..18 permutation, so each hole has a distinct
   * par/stroke-index pairing to assert against and header order can be checked.
   */
  const configuredCourse = (): Hole[] => {
    const pars = [4, 3, 5] as const;
    const strokeIndices = [
      10, 4, 14, 2, 16, 8, 12, 6, 18, 1, 11, 3, 15, 7, 13, 5, 9, 17,
    ];
    return HOLE_ORDINALS.map((ordinal, i) => ({
      ordinal,
      par: pars[i % 3] as Par,
      strokeIndex: strokeIndices[i] as unknown as StrokeIndex,
    }));
  };

  it('renders an 18-column header of ordinal/par/stroke-index in ascending ordinal order (Requirement 9.1)', () => {
    const holes = configuredCourse();
    const view = assemblerOver(holes, [], [], []).buildDay2View();

    expect(view.day).toBe(2);
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

  it('renders one row per player with the player name and Day 2 playing handicap (Requirement 9.2)', () => {
    const holes = configuredCourse();
    // Distinct Day 1 and Day 2 handicaps so the Day 2 (not Day 1) handicap can
    // be confirmed as the value surfaced.
    const players: Player[] = [
      { id: 'p1', name: 'Alice', handicapDay1: 8, handicapDay2: 9, cut: false },
      { id: 'p2', name: 'Bob', handicapDay1: 24, handicapDay2: 22, cut: false },
      {
        id: 'p3',
        name: 'Carol',
        handicapDay1: 12,
        handicapDay2: null,
        cut: false,
      },
    ];

    // No scores on either day, so every non-CUT player shares the same
    // ordering key and the assembler preserves the repository's alphabetical
    // order (Alice, Bob, Carol).
    const view = assemblerOver(holes, players, [], []).buildDay2View();

    // One row per player.
    expect(view.rows).toHaveLength(players.length);
    expect(view.rows.map((r) => r.playerId)).toEqual(['p1', 'p2', 'p3']);

    // Each row shows the player name and the Day 2 handicap (not Day 1), with a
    // missing Day 2 handicap surfaced as null.
    const byId = new Map(view.rows.map((r) => [r.playerId, r]));
    expect(byId.get('p1')).toMatchObject({ name: 'Alice', handicap: 9 });
    expect(byId.get('p2')).toMatchObject({ name: 'Bob', handicap: 22 });
    expect(byId.get('p3')).toMatchObject({ name: 'Carol', handicap: null });
  });

  it('surfaces the Day 2 handicap even when it differs sharply from the Day 1 handicap (Requirement 9.2)', () => {
    const holes = configuredCourse();
    const player: Player = {
      id: 'solo',
      name: 'Dana',
      handicapDay1: 4,
      handicapDay2: 30,
      cut: false,
    };

    const view = assemblerOver(holes, [player], [], []).buildDay2View();
    const row = view.rows.find((r) => r.playerId === 'solo')!;
    expect(row).toBeDefined();
    // The Day 2 handicap (30) is surfaced, not the Day 1 handicap (4).
    expect(row.handicap).toBe(30);
    expect(row.name).toBe('Dana');
  });
});
