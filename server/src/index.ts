/**
 * Server entrypoint and package barrel.
 *
 * This module both re-exports the domain/persistence/real-time layers (so
 * nothing is orphaned as later tasks build on them) and hosts the runnable
 * server bootstrap wired up in task 13.1: it builds the composition root
 * ({@link createAppContext}), constructs the Fastify app ({@link createApp})
 * serving the built frontend, and listens. The individual REST/SSE route
 * handlers are added in tasks 13.2–13.4 into the registration seam in `app.ts`.
 *
 * The bootstrap runs only when this file is executed directly (`node dist/index.js`
 * or the `start`/`dev` scripts); importing the module — as the tests and the
 * barrel consumers do — has no side effects.
 */

import type { Day } from '@ccs/types';
import { DAYS } from '@ccs/types';

// Domain layer: pure scoring/aggregation functions, re-exported so nothing is
// orphaned as later tasks wire the services, repository, and API on top.
export * from './stableford-calculator.js';
export * from './day-aggregation.js';
export * from './ranking-and-cut-service.js';

// Persistence layer: SQLite schema + database bootstrap, plus the Repository
// CRUD/upsert methods layered on top (task 6.2).
export * from './db.js';
export * from './repository.js';

// Domain services: coordinate persistence + validation on top of the repository.
export * from './course-setup-service.js';
export * from './competition-setup-service.js';
export * from './score-entry-service.js';

// View assembly: builds render-ready display snapshots from the persisted rows
// (task 10). Both the Day 1 and Day 2 views are implemented.
export * from './scores-display-assembler.js';

// Real-time layer: in-process event broker that assigns sequence ids, fans
// events out to SSE subscribers, and buffers recent events for Last-Event-ID
// replay (task 12).
export * from './event-broker.js';

// Composition root + HTTP app factory (task 13.1).
export * from './app-context.js';
export * from './app.js';

export function availableDays(): readonly Day[] {
  return DAYS;
}

import { pathToFileURL } from 'node:url';
import { createAppContext } from './app-context.js';
import { createApp, defaultStaticRoot } from './app.js';

/** Port the server listens on; overridable via the `PORT` env var. */
const DEFAULT_PORT = 3000;

/**
 * Boot the server: wire the composition root, build the Fastify app serving the
 * built frontend, and listen. Registers a SIGINT/SIGTERM handler that closes the
 * app and releases the database handle for a clean shutdown.
 *
 * @returns Resolves once the server is listening.
 */
export async function start(): Promise<void> {
  const context = createAppContext();
  const app = await createApp({
    context,
    staticRoot: defaultStaticRoot(),
    logger: true,
  });

  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST ?? '0.0.0.0';

  const shutdown = async (): Promise<void> => {
    await app.close();
    context.close();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

  await app.listen({ port, host });
}

// Run the bootstrap only when this module is the process entrypoint, so that
// importing the barrel (tests, tooling) has no side effects.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  start().catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
