/**
 * Composition root — instantiates the persistence, real-time, and domain layers
 * and wires them together into a single {@link AppContext} the HTTP layer draws
 * from (task 13.1).
 *
 * This is the one place that knows how the pieces fit: it opens the SQLite
 * database, constructs the {@link Repository} over it, creates the in-process
 * {@link EventBroker}, and threads both into every domain service and the view
 * assembler. Nothing above this layer constructs its own dependencies — the
 * Fastify app factory (see {@link ./app.ts}) receives a fully-built
 * {@link AppContext} (or builds the default one) and the route plugins added in
 * 13.2/13.3/13.4 read the services off it.
 *
 * Keeping construction here (rather than inside the route handlers) means the
 * same wiring is reused by the server entrypoint and by API-level tests, which
 * can build a context over an in-memory database (`':memory:'`) for isolation.
 */

import { openDatabase, type DatabaseHandle } from './db.js';
import { Repository } from './repository.js';
import { EventBroker } from './event-broker.js';
import { CourseSetupService } from './course-setup-service.js';
import { CompetitionSetupService } from './competition-setup-service.js';
import { ScoreEntryService } from './score-entry-service.js';
import { ScoresDisplayAssembler } from './scores-display-assembler.js';

/**
 * The fully-wired application object graph. Route plugins receive this and read
 * the services/broker they need; nothing here holds HTTP concerns.
 */
export interface AppContext {
  /** The opened, migrated SQLite handle. Closed via {@link AppContext.close}. */
  readonly db: DatabaseHandle;
  /** Persistence CRUD over the SQLite schema. */
  readonly repository: Repository;
  /** In-process pub/sub feeding the SSE endpoint (task 13.4). */
  readonly broker: EventBroker;
  /** Hole configuration + completeness (Requirement 1). */
  readonly courseSetup: CourseSetupService;
  /** Players, handicaps, Day 1 completion + cut (Requirements 2, 3). */
  readonly competitionSetup: CompetitionSetupService;
  /** Scorer submissions of gross strokes or NR (Requirement 7). */
  readonly scoreEntry: ScoreEntryService;
  /** Render-ready Day 1 / Day 2 view snapshots (Requirements 8, 9). */
  readonly assembler: ScoresDisplayAssembler;
  /** Release the database handle. Call on shutdown. */
  close(): void;
}

/** Options for {@link createAppContext}. */
export interface AppContextOptions {
  /**
   * Path to the SQLite database file, or `':memory:'` for an ephemeral in-memory
   * database (used by tests). Defaults to {@link DEFAULT_DATABASE_FILE}.
   */
  readonly databaseFile?: string;
}

/** Default on-disk SQLite file used when no override is supplied. */
export const DEFAULT_DATABASE_FILE = 'club-championship.db';

/**
 * Resolve the SQLite database file location.
 *
 * Order of precedence:
 *  1. An explicit `databaseFile` option (tests pass `':memory:'`).
 *  2. The `DATABASE_FILE` environment variable. In production (e.g. Railway)
 *     this points at a path on a mounted persistent volume so competition data
 *     survives restarts and redeploys — the container filesystem is otherwise
 *     ephemeral and would drop the database on every deploy.
 *  3. The local {@link DEFAULT_DATABASE_FILE} in the process working directory.
 *
 * @param override The explicit `databaseFile` option, if any.
 * @returns The database file path to open.
 */
export function resolveDatabaseFile(override?: string): string {
  if (override !== undefined) {
    return override;
  }
  const fromEnv = process.env.DATABASE_FILE?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_DATABASE_FILE;
}

/**
 * Build the application object graph: open the database, construct the
 * repository and broker, and wire every domain service and the assembler on top.
 *
 * Each domain service receives the shared {@link Repository} and the shared
 * {@link EventBroker}, so a successful persistence write in any service fans a
 * domain event out to the SSE endpoint through the one broker (task 12.3). The
 * assembler receives only the repository — it recomputes views on read and holds
 * no event state.
 *
 * @param options Optional overrides (notably the database file).
 * @returns A fully-wired {@link AppContext}. The caller owns its lifetime and
 *   must call {@link AppContext.close} on shutdown.
 */
export function createAppContext(options: AppContextOptions = {}): AppContext {
  const databaseFile = resolveDatabaseFile(options.databaseFile);

  const db = openDatabase(databaseFile);
  const repository = new Repository(db);
  const broker = new EventBroker();

  const courseSetup = new CourseSetupService(repository, broker);
  const competitionSetup = new CompetitionSetupService(repository, broker);
  const scoreEntry = new ScoreEntryService(repository, broker);
  const assembler = new ScoresDisplayAssembler(repository);

  return {
    db,
    repository,
    broker,
    courseSetup,
    competitionSetup,
    scoreEntry,
    assembler,
    close(): void {
      db.close();
    },
  };
}
