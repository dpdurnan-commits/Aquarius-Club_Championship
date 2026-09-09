import { describe, it, expect, beforeEach } from 'vitest';
import { NO_RETURN, UNRECORDED, numericCell } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';

function freshRepo(): Repository {
  return new Repository(openDatabase(':memory:'));
}

describe('Repository — holes (Requirements 1.6, 1.7)', () => {
  let repo: Repository;
  beforeEach(() => {
    repo = freshRepo();
  });

  it('seeds exactly 18 holes with null par/strokeIndex', () => {
    const holes = repo.getHoles();
    expect(holes).toHaveLength(18);
    expect(holes.map((h) => h.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(holes.every((h) => h.par === null && h.strokeIndex === null)).toBe(
      true,
    );
  });

  it('round-trips par and strokeIndex writes on read', () => {
    repo.setPar(1, 4);
    repo.setStrokeIndex(1, 7);
    const hole = repo.getHole(1);
    expect(hole).toEqual({ ordinal: 1, par: 4, strokeIndex: 7 });
  });

  it('reflects an updated par/strokeIndex (last write wins)', () => {
    repo.setPar(3, 3);
    repo.setPar(3, 5);
    repo.setStrokeIndex(3, 2);
    repo.setStrokeIndex(3, 10);
    expect(repo.getHole(3)).toEqual({ ordinal: 3, par: 5, strokeIndex: 10 });
  });
});

describe('Repository — players (Requirements 2.8, 2.9)', () => {
  let repo: Repository;
  beforeEach(() => {
    repo = freshRepo();
  });

  it('creates and reads a player with both per-day handicaps', () => {
    repo.createPlayer({
      id: 'p1',
      name: 'Alice',
      handicapDay1: 12,
      handicapDay2: 10,
    });
    expect(repo.getPlayer('p1')).toEqual({
      id: 'p1',
      name: 'Alice',
      handicapDay1: 12,
      handicapDay2: 10,
      cut: false,
      manualCut: false,
      orderDay1: 1,
      orderDay2: 1,
    });
  });

  it('defaults handicaps to null and cut to false when omitted', () => {
    repo.createPlayer({ id: 'p2', name: 'Bob' });
    expect(repo.getPlayer('p2')).toEqual({
      id: 'p2',
      name: 'Bob',
      handicapDay1: null,
      handicapDay2: null,
      cut: false,
      manualCut: false,
      orderDay1: 1,
      orderDay2: 1,
    });
  });

  it('persists updates to name and both handicaps independently', () => {
    repo.createPlayer({ id: 'p3', name: 'Carol', handicapDay1: 5, handicapDay2: 5 });
    repo.updatePlayerDetails('p3', {
      name: 'Caroline',
      handicapDay1: 6,
      handicapDay2: 9,
    });
    expect(repo.getPlayer('p3')).toMatchObject({
      name: 'Caroline',
      handicapDay1: 6,
      handicapDay2: 9,
    });
  });

  it('lists players ordered by name', () => {
    repo.createPlayer({ id: 'b', name: 'Zoe' });
    repo.createPlayer({ id: 'a', name: 'Amy' });
    expect(repo.getPlayers().map((p) => p.name)).toEqual(['Amy', 'Zoe']);
  });
});

describe('Repository — cut flags (Requirement 3.9)', () => {
  let repo: Repository;
  beforeEach(() => {
    repo = freshRepo();
    repo.createPlayer({ id: 'p1', name: 'Alice' });
    repo.createPlayer({ id: 'p2', name: 'Bob' });
  });

  it('round-trips a single player cut flag', () => {
    repo.setPlayerCut('p1', true);
    expect(repo.getPlayer('p1')?.cut).toBe(true);
    repo.setPlayerCut('p1', false);
    expect(repo.getPlayer('p1')?.cut).toBe(false);
  });

  it('applies a batch of cut flags atomically', () => {
    repo.setPlayerCuts(
      new Map([
        ['p1', true],
        ['p2', false],
      ]),
    );
    expect(repo.getPlayer('p1')?.cut).toBe(true);
    expect(repo.getPlayer('p2')?.cut).toBe(false);
  });
});

describe('Repository — scores upsert (Requirements 7.5, 7.6, 7.10)', () => {
  let repo: Repository;
  beforeEach(() => {
    repo = freshRepo();
    repo.createPlayer({ id: 'p1', name: 'Alice' });
    repo.createPlayer({ id: 'p2', name: 'Bob' });
  });

  it('starts unrecorded when no row exists', () => {
    expect(repo.getScore('p1', 1, 1)).toBeUndefined();
    expect(repo.getCellState('p1', 1, 1)).toEqual(UNRECORDED);
  });

  it('upserts a numeric cell and reads it back', () => {
    repo.upsertScore('p1', 1, 5, numericCell(4));
    expect(repo.getCellState('p1', 1, 5)).toEqual(numericCell(4));
    expect(repo.getScore('p1', 1, 5)).toEqual({
      playerId: 'p1',
      day: 1,
      ordinal: 5,
      gross: 4,
      noReturn: false,
    });
  });

  it('upserts an NR cell and reads it back', () => {
    repo.upsertScore('p1', 2, 9, NO_RETURN);
    expect(repo.getCellState('p1', 2, 9)).toEqual(NO_RETURN);
    expect(repo.getScore('p1', 2, 9)).toMatchObject({
      gross: null,
      noReturn: true,
    });
  });

  it('replaces existing value last-write-wins (numeric → numeric)', () => {
    repo.upsertScore('p1', 1, 1, numericCell(6));
    repo.upsertScore('p1', 1, 1, numericCell(3));
    expect(repo.getCellState('p1', 1, 1)).toEqual(numericCell(3));
  });

  it('lets numeric and NR freely replace each other on the same cell', () => {
    repo.upsertScore('p1', 1, 1, numericCell(5));
    repo.upsertScore('p1', 1, 1, NO_RETURN);
    expect(repo.getCellState('p1', 1, 1)).toEqual(NO_RETURN);
    repo.upsertScore('p1', 1, 1, numericCell(4));
    expect(repo.getCellState('p1', 1, 1)).toEqual(numericCell(4));
  });

  it('clears a cell back to unrecorded', () => {
    repo.upsertScore('p1', 1, 1, numericCell(4));
    repo.upsertScore('p1', 1, 1, UNRECORDED);
    expect(repo.getScore('p1', 1, 1)).toBeUndefined();
    expect(repo.getCellState('p1', 1, 1)).toEqual(UNRECORDED);
  });

  it('persists writes to distinct cells independently', () => {
    repo.upsertScore('p1', 1, 1, numericCell(4));
    repo.upsertScore('p2', 1, 1, numericCell(5));
    repo.upsertScore('p1', 2, 1, NO_RETURN);
    expect(repo.getCellState('p1', 1, 1)).toEqual(numericCell(4));
    expect(repo.getCellState('p2', 1, 1)).toEqual(numericCell(5));
    expect(repo.getCellState('p1', 2, 1)).toEqual(NO_RETURN);
  });

  it('filters scores by day', () => {
    repo.upsertScore('p1', 1, 1, numericCell(4));
    repo.upsertScore('p1', 2, 1, numericCell(5));
    const day1 = repo.getScoresForDay(1);
    expect(day1).toHaveLength(1);
    expect(day1[0]).toMatchObject({ day: 1, gross: 4 });
  });
});

describe('Repository — competition state', () => {
  let repo: Repository;
  beforeEach(() => {
    repo = freshRepo();
  });

  it('seeds with Day 1 not complete and no cut value', () => {
    expect(repo.getCompetitionState()).toEqual({
      day1Complete: false,
      cutValue: null,
    });
  });

  it('round-trips day1Complete and cutValue', () => {
    repo.setCompetitionState({ day1Complete: true, cutValue: 10 });
    expect(repo.getCompetitionState()).toEqual({
      day1Complete: true,
      cutValue: 10,
    });
  });
});
