import { describe, it, expect } from 'vitest';
import { openDatabase, migrate, COMPETITION_STATE_ID } from './db.js';

describe('database bootstrap', () => {
  it('seeds exactly 18 hole rows keyed 1..18 with null par/strokeIndex on first run', () => {
    const db = openDatabase(':memory:');

    const rows = db
      .prepare('SELECT ordinal, par, strokeIndex FROM hole ORDER BY ordinal')
      .all() as { ordinal: number; par: number | null; strokeIndex: number | null }[];

    expect(rows).toHaveLength(18);
    expect(rows.map((r) => r.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(rows.every((r) => r.par === null && r.strokeIndex === null)).toBe(true);

    db.close();
  });

  it('seeds a single competition-state row with Day 1 incomplete and no cut value', () => {
    const db = openDatabase(':memory:');

    const rows = db
      .prepare('SELECT id, day1Complete, cutValue FROM competition_state')
      .all() as { id: number; day1Complete: number; cutValue: number | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: COMPETITION_STATE_ID,
      day1Complete: 0,
      cutValue: null,
    });

    db.close();
  });

  it('creates all four tables', () => {
    const db = openDatabase(':memory:');

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toEqual(
      expect.arrayContaining(['hole', 'player', 'score', 'competition_state']),
    );

    db.close();
  });

  it('re-running migrate is idempotent and preserves existing data', () => {
    const db = openDatabase(':memory:');

    // Configure a hole and mark Day 1 complete, then re-run the bootstrap.
    db.prepare('UPDATE hole SET par = 4, strokeIndex = 1 WHERE ordinal = 1').run();
    db.prepare(
      'UPDATE competition_state SET day1Complete = 1, cutValue = 10 WHERE id = ?',
    ).run(COMPETITION_STATE_ID);

    migrate(db);

    const holeCount = (
      db.prepare('SELECT count(*) AS c FROM hole').get() as { c: number }
    ).c;
    const stateCount = (
      db.prepare('SELECT count(*) AS c FROM competition_state').get() as {
        c: number;
      }
    ).c;
    const hole1 = db
      .prepare('SELECT par, strokeIndex FROM hole WHERE ordinal = 1')
      .get() as { par: number | null; strokeIndex: number | null };
    const state = db
      .prepare('SELECT day1Complete, cutValue FROM competition_state WHERE id = ?')
      .get(COMPETITION_STATE_ID) as { day1Complete: number; cutValue: number | null };

    expect(holeCount).toBe(18);
    expect(stateCount).toBe(1);
    expect(hole1).toEqual({ par: 4, strokeIndex: 1 });
    expect(state).toEqual({ day1Complete: 1, cutValue: 10 });

    db.close();
  });

  it('rejects a second competition-state row (singleton enforced)', () => {
    const db = openDatabase(':memory:');

    expect(() =>
      db
        .prepare('INSERT INTO competition_state (id, day1Complete, cutValue) VALUES (2, 0, NULL)')
        .run(),
    ).toThrow();

    db.close();
  });
});
