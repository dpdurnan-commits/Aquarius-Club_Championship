/**
 * Repository — the persistence CRUD layer over the SQLite schema in `db.ts`.
 *
 * This module owns all reads and writes against the `hole`, `player`, `score`,
 * and `competition_state` tables. It deliberately contains *only* persistence:
 * validation (range checks, uniqueness, cut rules, validate-reject-retain) lives
 * in the domain services layered on top (CourseSetupService, CompetitionSetup-
 * Service, ScoreEntryService — tasks 7/8/9). The repository exposes plain read/
 * write methods those services call.
 *
 * Key behaviours mandated by the requirements/design:
 *  - Holes: read all 18; write/update par and stroke index; reads reflect writes
 *    (round-trip). (Requirements 1.6, 1.7)
 *  - Players: create/read/update name and both per-day handicaps; persisted and
 *    read back. (Requirements 2.8, 2.9)
 *  - Scores: upsert per `(playerId, day, ordinal)` cell, replacing any existing
 *    value (last-write-wins), supporting numeric and NR states. Each score
 *    upsert runs in its OWN transaction so concurrent submissions to distinct
 *    cells both persist. (Requirements 7.5, 7.6, 7.10)
 *  - Competition state: read/write `day1Complete` and `cutValue`.
 *  - Cut flags: read/write each player's cut status, set at Day 1 completion.
 *    (Requirement 3.9)
 *
 * Booleans are stored as INTEGER 0/1 in SQLite; this module converts at the
 * boundary so callers work with real `boolean`s and the domain `CellState`.
 */

import type {
  CellState,
  CompetitionState,
  Day,
  Gross,
  Hole,
  HoleOrdinal,
  Par,
  Player,
  PlayingHandicap,
  Score,
  StrokeIndex,
} from '@ccs/types';
import { cellStateOf } from '@ccs/types';
import type { DatabaseHandle } from './db.js';
import { COMPETITION_STATE_ID } from './db.js';

/** SQLite stores booleans as INTEGER 0/1; convert on the way in. */
function toInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** SQLite stores booleans as INTEGER 0/1; convert on the way out. */
function toBool(value: number): boolean {
  return value !== 0;
}

/** Raw row shape for the `hole` table. */
interface HoleRow {
  ordinal: number;
  par: number | null;
  strokeIndex: number | null;
}

/** Raw row shape for the `player` table. */
interface PlayerRow {
  id: string;
  name: string;
  handicapDay1: number | null;
  handicapDay2: number | null;
  cut: number;
  manualCut: number;
  orderDay1: number;
  orderDay2: number;
}

/** Raw row shape for the `score` table. */
interface ScoreRow {
  playerId: string;
  day: number;
  ordinal: number;
  gross: number | null;
  noReturn: number;
}

/** Raw row shape for the `competition_state` table. */
interface CompetitionStateRow {
  day1Complete: number;
  cutValue: number | null;
}

function mapHole(row: HoleRow): Hole {
  return {
    ordinal: row.ordinal as HoleOrdinal,
    par: row.par as Par | null,
    strokeIndex: row.strokeIndex as StrokeIndex | null,
  };
}

function mapPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    handicapDay1: row.handicapDay1 as PlayingHandicap | null,
    handicapDay2: row.handicapDay2 as PlayingHandicap | null,
    cut: toBool(row.cut),
    manualCut: toBool(row.manualCut),
    orderDay1: row.orderDay1,
    orderDay2: row.orderDay2,
  };
}

function mapScore(row: ScoreRow): Score {
  return {
    playerId: row.playerId,
    day: row.day as Day,
    ordinal: row.ordinal as HoleOrdinal,
    gross: row.gross as Gross | null,
    noReturn: toBool(row.noReturn),
  };
}

function mapCompetitionState(row: CompetitionStateRow): CompetitionState {
  return {
    day1Complete: toBool(row.day1Complete),
    cutValue: row.cutValue,
  };
}

/**
 * Persistence CRUD over the SQLite schema. Statements are prepared once in the
 * constructor and reused, which is the idiomatic better-sqlite3 pattern and
 * keeps per-call overhead minimal. All methods are synchronous, matching
 * better-sqlite3's synchronous API.
 */
export class Repository {
  private readonly db: DatabaseHandle;

  private readonly selectAllHoles;
  private readonly selectHole;
  private readonly updateHolePar;
  private readonly updateHoleStrokeIndex;

  private readonly selectAllPlayers;
  private readonly selectPlayersByDay1Order;
  private readonly selectPlayersByDay2Order;
  private readonly selectPlayer;
  private readonly insertPlayer;
  private readonly updatePlayer;
  private readonly updatePlayerCut;
  private readonly updatePlayerManualCut;
  private readonly selectMaxOrder;
  private readonly updatePlayerOrderDay1;
  private readonly updatePlayerOrderDay2;

  private readonly selectAllScores;
  private readonly selectScoresForDay;
  private readonly selectScore;
  private readonly upsertScoreStmt;
  private readonly deleteScoreStmt;

  private readonly selectState;
  private readonly updateStateStmt;
  private readonly deleteAllScoresStmt;
  private readonly deleteAllPlayersStmt;

  constructor(db: DatabaseHandle) {
    this.db = db;

    this.selectAllHoles = db.prepare(
      'SELECT ordinal, par, strokeIndex FROM hole ORDER BY ordinal',
    );
    this.selectHole = db.prepare(
      'SELECT ordinal, par, strokeIndex FROM hole WHERE ordinal = ?',
    );
    this.updateHolePar = db.prepare('UPDATE hole SET par = ? WHERE ordinal = ?');
    this.updateHoleStrokeIndex = db.prepare(
      'UPDATE hole SET strokeIndex = ? WHERE ordinal = ?',
    );

    this.selectAllPlayers = db.prepare(
      'SELECT id, name, handicapDay1, handicapDay2, cut, manualCut, orderDay1, orderDay2 FROM player ORDER BY name',
    );
    // Per-day ordered listings drive the Score Entry grid row order. Ties on the
    // order column fall back to name for a stable, deterministic sequence.
    this.selectPlayersByDay1Order = db.prepare(
      'SELECT id, name, handicapDay1, handicapDay2, cut, manualCut, orderDay1, orderDay2 FROM player ORDER BY orderDay1, name',
    );
    this.selectPlayersByDay2Order = db.prepare(
      'SELECT id, name, handicapDay1, handicapDay2, cut, manualCut, orderDay1, orderDay2 FROM player ORDER BY orderDay2, name',
    );
    this.selectPlayer = db.prepare(
      'SELECT id, name, handicapDay1, handicapDay2, cut, manualCut, orderDay1, orderDay2 FROM player WHERE id = ?',
    );
    this.insertPlayer = db.prepare(
      'INSERT INTO player (id, name, handicapDay1, handicapDay2, cut, manualCut, orderDay1, orderDay2) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.updatePlayer = db.prepare(
      'UPDATE player SET name = ?, handicapDay1 = ?, handicapDay2 = ? WHERE id = ?',
    );
    this.updatePlayerCut = db.prepare('UPDATE player SET cut = ? WHERE id = ?');
    // Sets both the manual-cut override and the effective cut flag together, so a
    // manual withdrawal takes effect immediately without waiting for a Day 1
    // re-evaluation.
    this.updatePlayerManualCut = db.prepare(
      'UPDATE player SET manualCut = ?, cut = ? WHERE id = ?',
    );
    // The next append position for a new player is one past the current max of
    // each day's order column (0 when the roster is empty).
    this.selectMaxOrder = db.prepare(
      'SELECT COALESCE(MAX(orderDay1), 0) AS maxDay1, COALESCE(MAX(orderDay2), 0) AS maxDay2 FROM player',
    );
    this.updatePlayerOrderDay1 = db.prepare(
      'UPDATE player SET orderDay1 = ? WHERE id = ?',
    );
    this.updatePlayerOrderDay2 = db.prepare(
      'UPDATE player SET orderDay2 = ? WHERE id = ?',
    );

    this.selectAllScores = db.prepare(
      'SELECT playerId, day, ordinal, gross, noReturn FROM score',
    );
    this.selectScoresForDay = db.prepare(
      'SELECT playerId, day, ordinal, gross, noReturn FROM score WHERE day = ?',
    );
    this.selectScore = db.prepare(
      'SELECT playerId, day, ordinal, gross, noReturn FROM score WHERE playerId = ? AND day = ? AND ordinal = ?',
    );
    // Upsert against the composite primary key. ON CONFLICT DO UPDATE gives
    // last-write-wins for the cell, letting numeric and NR states freely
    // replace each other.
    this.upsertScoreStmt = db.prepare(
      `INSERT INTO score (playerId, day, ordinal, gross, noReturn)
       VALUES (@playerId, @day, @ordinal, @gross, @noReturn)
       ON CONFLICT(playerId, day, ordinal)
       DO UPDATE SET gross = excluded.gross, noReturn = excluded.noReturn`,
    );
    this.deleteScoreStmt = db.prepare(
      'DELETE FROM score WHERE playerId = ? AND day = ? AND ordinal = ?',
    );

    this.selectState = db.prepare(
      'SELECT day1Complete, cutValue FROM competition_state WHERE id = ?',
    );
    this.updateStateStmt = db.prepare(
      'UPDATE competition_state SET day1Complete = ?, cutValue = ? WHERE id = ?',
    );

    // Bulk deletes used by the end-of-year reset. Deleting players cascades to
    // their scores via the FK, but scores are cleared explicitly as well so the
    // reset is unambiguous regardless of cascade configuration.
    this.deleteAllScoresStmt = db.prepare('DELETE FROM score');
    this.deleteAllPlayersStmt = db.prepare('DELETE FROM player');
  }

  // --- Holes (Requirements 1.6, 1.7) --------------------------------------

  /** Return all 18 holes ordered by ordinal, with nulls where par/SI unset. */
  getHoles(): Hole[] {
    return (this.selectAllHoles.all() as HoleRow[]).map(mapHole);
  }

  /** Return a single hole by ordinal, or `undefined` if none (never, given seed). */
  getHole(ordinal: HoleOrdinal): Hole | undefined {
    const row = this.selectHole.get(ordinal) as HoleRow | undefined;
    return row ? mapHole(row) : undefined;
  }

  /** Persist the par for a hole (null clears it). Read reflects the write. */
  setPar(ordinal: HoleOrdinal, par: Par | null): void {
    this.updateHolePar.run(par, ordinal);
  }

  /** Persist the stroke index for a hole (null clears it). Read reflects the write. */
  setStrokeIndex(ordinal: HoleOrdinal, strokeIndex: StrokeIndex | null): void {
    this.updateHoleStrokeIndex.run(strokeIndex, ordinal);
  }

  // --- Players (Requirements 2.8, 2.9) ------------------------------------

  /** Return all players ordered by name. */
  getPlayers(): Player[] {
    return (this.selectAllPlayers.all() as PlayerRow[]).map(mapPlayer);
  }

  /**
   * Return all players in the administrator-controlled display order for a day.
   * Day 1 and Day 2 have independent orderings; this is the row order the Score
   * Entry grid renders. Ties fall back to name for a stable sequence.
   */
  getPlayersOrdered(day: Day): Player[] {
    const statement =
      day === 1 ? this.selectPlayersByDay1Order : this.selectPlayersByDay2Order;
    return (statement.all() as PlayerRow[]).map(mapPlayer);
  }

  /** Return a single player by id, or `undefined` if not found. */
  getPlayer(id: string): Player | undefined {
    const row = this.selectPlayer.get(id) as PlayerRow | undefined;
    return row ? mapPlayer(row) : undefined;
  }

  /**
   * Create a new player. Handicaps default to null (unset) and cut to false.
   * The player is appended to the end of both days' orderings (one past the
   * current max), so a freshly added player never displaces the existing order.
   * The caller is responsible for supplying a unique id and validating name/
   * handicap ranges; the schema's UNIQUE/CHECK constraints are the backstop.
   */
  createPlayer(player: {
    id: string;
    name: string;
    handicapDay1?: PlayingHandicap | null;
    handicapDay2?: PlayingHandicap | null;
  }): void {
    const { maxDay1, maxDay2 } = this.selectMaxOrder.get() as {
      maxDay1: number;
      maxDay2: number;
    };
    this.insertPlayer.run(
      player.id,
      player.name,
      player.handicapDay1 ?? null,
      player.handicapDay2 ?? null,
      toInt(false),
      toInt(false),
      maxDay1 + 1,
      maxDay2 + 1,
    );
  }

  /**
   * Persist a new display order for a day from an ordered list of player ids.
   * Each id is assigned a dense 1-based position in the given day's order column
   * in a single transaction (all-or-nothing), leaving the other day untouched.
   * Ids not present are unchanged; the caller validates that the list covers the
   * roster.
   */
  setPlayerOrder(day: Day, orderedIds: readonly string[]): void {
    const statement =
      day === 1 ? this.updatePlayerOrderDay1 : this.updatePlayerOrderDay2;
    const apply = this.db.transaction((ids: readonly string[]) => {
      ids.forEach((id, index) => {
        statement.run(index + 1, id);
      });
    });
    apply(orderedIds);
  }

  /** Update a player's name and both per-day handicaps. Reads reflect the write. */
  updatePlayerDetails(
    id: string,
    details: {
      name: string;
      handicapDay1: PlayingHandicap | null;
      handicapDay2: PlayingHandicap | null;
    },
  ): void {
    this.updatePlayer.run(
      details.name,
      details.handicapDay1,
      details.handicapDay2,
      id,
    );
  }

  // --- Cut flags (Requirement 3.9) ----------------------------------------

  /** Set a single player's cut status. Used at Day 1 completion. */
  setPlayerCut(id: string, cut: boolean): void {
    this.updatePlayerCut.run(toInt(cut), id);
  }

  /**
   * Set a player's manual-cut override and their effective cut flag together.
   * The manual override persists across Day 1 completion/reversal (which only
   * touch the derived `cut`), while the effective `cut` is what every consumer
   * reads to suppress Day 2. Callers pass the effective cut (typically the
   * manual override OR the current auto cut).
   */
  setPlayerManualCut(id: string, manualCut: boolean, effectiveCut: boolean): void {
    this.updatePlayerManualCut.run(toInt(manualCut), toInt(effectiveCut), id);
  }

  /**
   * Set cut status for many players atomically. Day 1 completion evaluates the
   * cut for every player, so applying them in one transaction keeps the set
   * consistent (all-or-nothing).
   */
  setPlayerCuts(cutByPlayer: ReadonlyMap<string, boolean>): void {
    const apply = this.db.transaction(
      (entries: readonly (readonly [string, boolean])[]) => {
        for (const [id, cut] of entries) {
          this.updatePlayerCut.run(toInt(cut), id);
        }
      },
    );
    apply([...cutByPlayer.entries()]);
  }

  // --- Scores (Requirements 7.5, 7.6, 7.10) -------------------------------

  /** Return every score row across both days. */
  getScores(): Score[] {
    return (this.selectAllScores.all() as ScoreRow[]).map(mapScore);
  }

  /** Return all score rows for a given day. */
  getScoresForDay(day: Day): Score[] {
    return (this.selectScoresForDay.all(day) as ScoreRow[]).map(mapScore);
  }

  /** Return the score row for a cell, or `undefined` when unrecorded. */
  getScore(
    playerId: string,
    day: Day,
    ordinal: HoleOrdinal,
  ): Score | undefined {
    const row = this.selectScore.get(playerId, day, ordinal) as
      | ScoreRow
      | undefined;
    return row ? mapScore(row) : undefined;
  }

  /**
   * Return the {@link CellState} for a cell (unrecorded / numeric / NR),
   * deriving it from the persisted row (or its absence).
   */
  getCellState(
    playerId: string,
    day: Day,
    ordinal: HoleOrdinal,
  ): CellState {
    return cellStateOf(this.getScore(playerId, day, ordinal));
  }

  /**
   * Upsert a single score cell, replacing any existing value (last-write-wins).
   *
   * The write runs in its OWN transaction keyed on the unique
   * `(playerId, day, ordinal)` cell, so concurrent submissions to *different*
   * cells never conflict and both persist. (Requirements 7.6, 7.10)
   *
   * The three cell states map to columns as follows:
   *  - numeric: `{ kind: 'numeric', gross }` → `gross` set, `noReturn = false`
   *  - NR:      `{ kind: 'NR' }`             → `gross = null`, `noReturn = true`
   *  - unrecorded: `{ kind: 'unrecorded' }`  → the row is deleted (cell cleared)
   *
   * Numeric and NR freely replace each other because the upsert overwrites both
   * columns on conflict.
   */
  upsertScore(
    playerId: string,
    day: Day,
    ordinal: HoleOrdinal,
    state: CellState,
  ): void {
    const write = this.db.transaction(() => {
      if (state.kind === 'unrecorded') {
        this.deleteScoreStmt.run(playerId, day, ordinal);
        return;
      }
      const gross = state.kind === 'numeric' ? state.gross : null;
      const noReturn = state.kind === 'NR';
      this.upsertScoreStmt.run({
        playerId,
        day,
        ordinal,
        gross,
        noReturn: toInt(noReturn),
      });
    });
    write();
  }

  // --- Competition state --------------------------------------------------

  /** Read the singleton competition state (day1Complete + cutValue). */
  getCompetitionState(): CompetitionState {
    const row = this.selectState.get(COMPETITION_STATE_ID) as CompetitionStateRow;
    return mapCompetitionState(row);
  }

  /** Write the singleton competition state (day1Complete + cutValue). */
  setCompetitionState(state: CompetitionState): void {
    this.updateStateStmt.run(
      toInt(state.day1Complete),
      state.cutValue,
      COMPETITION_STATE_ID,
    );
  }

  // --- End-of-year reset --------------------------------------------------

  /**
   * Clear all players and scores and reset the competition state, returning the
   * app to a blank canvas for reuse in a new year. The 18 hole configuration
   * rows (par / stroke index) are intentionally KEPT, since the course is
   * typically unchanged between years — pass `resetCourse: true` to also clear
   * those back to unconfigured.
   *
   * Everything runs in a single transaction, so the reset is all-or-nothing: a
   * failure mid-way leaves the prior data intact.
   *
   * @param resetCourse When true, also clears every hole's par and stroke index.
   */
  resetCompetition(resetCourse = false): void {
    const reset = this.db.transaction(() => {
      this.deleteAllScoresStmt.run();
      this.deleteAllPlayersStmt.run();
      this.updateStateStmt.run(toInt(false), null, COMPETITION_STATE_ID);
      if (resetCourse) {
        for (const hole of this.getHoles()) {
          this.updateHolePar.run(null, hole.ordinal);
          this.updateHoleStrokeIndex.run(null, hole.ordinal);
        }
      }
    });
    reset();
  }
}
