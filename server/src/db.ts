/**
 * SQLite schema and database bootstrap for the Club Championship Scoring tool.
 *
 * This module owns the single embedded SQLite database file described in the
 * design's Data Models section. It is the persistence foundation the repository
 * layer (task 6.2) builds on; it deliberately contains only schema creation and
 * first-run seeding, not the CRUD/upsert methods.
 *
 * The schema mirrors the four persisted entities. Derived values (aggregates,
 * Stableford points, relative-to-par, competition positions) are NOT stored and
 * therefore have no columns here; the server recomputes them on read. The one
 * derived-yet-persisted status is a player's CUT flag, set at Day 1 completion.
 *
 *  - HOLE: exactly 18 rows keyed by `ordinal` (1..18); `par` and `strokeIndex`
 *    are nullable until configured. (Requirement 1.1)
 *  - PLAYER: `id` PK, `name` unique, per-day handicaps, and a `cut` flag.
 *  - SCORE: one row per `(playerId, day, ordinal)` cell; `gross` is null when
 *    the cell is NR or unrecorded, and `noReturn` flags the NR state.
 *  - COMPETITION_STATE: a single row holding `day1Complete` and `cutValue`.
 *    On first run it is seeded with Day 1 not complete and no cut value, so no
 *    player is CUT before Day 1 is marked complete. (Requirement 3.8)
 */

import Database from 'better-sqlite3';
import { HOLE_ORDINALS } from '@ccs/types';

/** The better-sqlite3 database handle type, re-exported for the repository. */
export type DatabaseHandle = Database.Database;

/**
 * The fixed primary-key of the single-row COMPETITION_STATE table. A `CHECK`
 * constraint pins it to this value so the table can never hold more than one
 * row (the "singleton row" pattern).
 */
export const COMPETITION_STATE_ID = 1 as const;

/**
 * Data-definition SQL for the whole schema. `CREATE TABLE IF NOT EXISTS`
 * statements make opening an existing database idempotent — the DDL runs on
 * every open but only creates tables on first run.
 *
 * Types use SQLite affinities. Booleans are stored as INTEGER 0/1 (SQLite has
 * no native boolean); `noReturn`, `cut`, and `day1Complete` all use a
 * `CHECK (col IN (0, 1))` guard. Range checks encode the domain bounds from the
 * requirements so malformed rows cannot be persisted even if a caller misbehaves.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hole (
  ordinal     INTEGER PRIMARY KEY
              CHECK (ordinal BETWEEN 1 AND 18),
  par         INTEGER
              CHECK (par IS NULL OR par BETWEEN 3 AND 6),
  strokeIndex INTEGER UNIQUE
              CHECK (strokeIndex IS NULL OR strokeIndex BETWEEN 1 AND 18)
);

CREATE TABLE IF NOT EXISTS player (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE
               CHECK (length(name) BETWEEN 1 AND 100),
  handicapDay1 INTEGER
               CHECK (handicapDay1 IS NULL OR handicapDay1 BETWEEN 0 AND 36),
  handicapDay2 INTEGER
               CHECK (handicapDay2 IS NULL OR handicapDay2 BETWEEN 0 AND 36),
  cut          INTEGER NOT NULL DEFAULT 0
               CHECK (cut IN (0, 1)),
  manualCut    INTEGER NOT NULL DEFAULT 0
               CHECK (manualCut IN (0, 1)),
  orderDay1    INTEGER NOT NULL DEFAULT 0,
  orderDay2    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS score (
  playerId TEXT NOT NULL
           REFERENCES player(id) ON DELETE CASCADE,
  day      INTEGER NOT NULL
           CHECK (day IN (1, 2)),
  ordinal  INTEGER NOT NULL
           REFERENCES hole(ordinal)
           CHECK (ordinal BETWEEN 1 AND 18),
  gross    INTEGER
           CHECK (gross IS NULL OR gross BETWEEN 1 AND 20),
  noReturn INTEGER NOT NULL DEFAULT 0
           CHECK (noReturn IN (0, 1)),
  PRIMARY KEY (playerId, day, ordinal)
);

CREATE TABLE IF NOT EXISTS competition_state (
  id           INTEGER PRIMARY KEY
               CHECK (id = ${COMPETITION_STATE_ID}),
  day1Complete INTEGER NOT NULL DEFAULT 0
               CHECK (day1Complete IN (0, 1)),
  cutValue     INTEGER
               CHECK (cutValue IS NULL OR cutValue > 0)
);
`;

/**
 * Open (or create) the SQLite database at `filename`, apply the schema, and
 * seed first-run rows. Passing `':memory:'` yields an ephemeral in-memory
 * database, which the repository tests (task 6.2+) use for isolation.
 *
 * The whole open is idempotent: re-opening an existing database re-applies the
 * `IF NOT EXISTS` DDL without disturbing data, and seeding uses
 * `INSERT OR IGNORE`, so the 18 hole rows and the single competition-state row
 * are created only if they are missing.
 *
 * Pragmas: `foreign_keys = ON` enforces the SCORE→PLAYER/HOLE references, and
 * `journal_mode = WAL` improves concurrent read/write behavior for the several
 * simultaneous scorers the design anticipates. (Requirement 7.10)
 *
 * @param filename Path to the SQLite file, or `':memory:'` for an in-memory DB.
 * @returns The opened, migrated, and seeded database handle.
 */
export function openDatabase(filename: string): DatabaseHandle {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

/**
 * Apply the schema and seed first-run data on an already-open database handle.
 * Exposed separately from {@link openDatabase} so callers that manage their own
 * handle (or tests) can bootstrap an existing connection. Safe to call more than
 * once thanks to the idempotent DDL and seed statements.
 *
 * @param db An open better-sqlite3 database handle.
 */
export function migrate(db: DatabaseHandle): void {
  // Create tables (idempotent). Wrapped so a partial failure rolls back.
  db.exec(SCHEMA_SQL);
  // Bring pre-existing databases up to the current column set before seeding.
  addMissingColumns(db);
  seed(db);
}

/**
 * Idempotently add columns introduced after the initial schema to databases
 * created by an earlier version. `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so new columns must be added with `ALTER TABLE`. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so this inspects `PRAGMA table_info` first and only
 * adds a column when it is absent, making the migration safe to run on every open.
 *
 * The two player order columns (`orderDay1`, `orderDay2`) drive the per-day Score
 * Entry grid ordering. On an existing database they are backfilled from the
 * current alphabetical name order so every player has a distinct, sensible
 * starting position the administrator can then rearrange.
 *
 * @param db An open better-sqlite3 database handle.
 */
function addMissingColumns(db: DatabaseHandle): void {
  const playerColumns = new Set(
    (db.prepare('PRAGMA table_info(player)').all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );

  const backfill = db.transaction(() => {
    if (!playerColumns.has('orderDay1')) {
      db.exec('ALTER TABLE player ADD COLUMN orderDay1 INTEGER NOT NULL DEFAULT 0');
    }
    if (!playerColumns.has('orderDay2')) {
      db.exec('ALTER TABLE player ADD COLUMN orderDay2 INTEGER NOT NULL DEFAULT 0');
    }
    // The manual-cut override (players who won't return for Day 2). Defaults to
    // 0, so existing players start with no override.
    if (!playerColumns.has('manualCut')) {
      db.exec('ALTER TABLE player ADD COLUMN manualCut INTEGER NOT NULL DEFAULT 0');
    }

    // Backfill positions for any player still on the default 0 (either freshly
    // added columns above, or rows inserted before ordering existed). Assign a
    // dense 1-based sequence following the existing name order so the two days
    // start identical and every position is distinct.
    const needsBackfill =
      (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM player WHERE orderDay1 = 0 OR orderDay2 = 0',
          )
          .get() as { n: number }
      ).n > 0;
    if (needsBackfill) {
      const ids = (
        db.prepare('SELECT id FROM player ORDER BY name').all() as {
          id: string;
        }[]
      ).map((row) => row.id);
      const setOrder = db.prepare(
        'UPDATE player SET orderDay1 = ?, orderDay2 = ? WHERE id = ?',
      );
      ids.forEach((id, index) => {
        const position = index + 1;
        setOrder.run(position, position, id);
      });
    }
  });

  backfill();
}

/**
 * Seed the fixed first-run rows: the 18 hole slots (ordinals 1..18, par and
 * stroke index left null until configured) and the single competition-state row
 * (Day 1 not complete, no cut value — so no player is CUT before completion,
 * per Requirement 3.8). Uses `INSERT OR IGNORE` so existing rows are preserved
 * on subsequent opens. Runs in a single transaction so the seed is all-or-nothing.
 *
 * @param db An open, migrated better-sqlite3 database handle.
 */
function seed(db: DatabaseHandle): void {
  const insertHole = db.prepare(
    'INSERT OR IGNORE INTO hole (ordinal, par, strokeIndex) VALUES (?, NULL, NULL)',
  );
  const insertState = db.prepare(
    'INSERT OR IGNORE INTO competition_state (id, day1Complete, cutValue) VALUES (?, 0, NULL)',
  );

  const seedAll = db.transaction(() => {
    for (const ordinal of HOLE_ORDINALS) {
      insertHole.run(ordinal);
    }
    insertState.run(COMPETITION_STATE_ID);
  });

  seedAll();
}
