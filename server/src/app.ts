/**
 * Fastify app factory — assembles the HTTP server from a wired
 * {@link AppContext} (task 13.1).
 *
 * This module owns the shape of the running server without owning any single
 * endpoint's logic. It:
 *  - decorates the Fastify instance with the {@link AppContext} so route plugins
 *    can read the domain services/broker off `fastify.appContext`;
 *  - registers the API route plugins under the `/api` prefix (the individual
 *    course/player/day1/score/view/SSE handlers are added in tasks 13.2–13.4;
 *    here we establish the `registerApiRoutes` seam they slot into);
 *  - serves the built frontend static assets with a SPA fallback so client-side
 *    routes resolve to `index.html` (Requirement 7.9).
 *
 * The factory is intentionally I/O-light: it does not open the database or bind
 * a port. {@link createApp} receives an already-built context (tests pass one
 * over an in-memory database), and the server entrypoint (`index.ts`) is the
 * only place that constructs the default context and calls `listen`.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './app-context.js';
import { courseRoutes } from './routes/course-routes.js';
import { playerRoutes } from './routes/player-routes.js';
import { day1Routes } from './routes/day1-routes.js';
import { scoreRoutes } from './routes/score-routes.js';
import { viewRoutes } from './routes/view-routes.js';
import { eventsRoutes } from './routes/events-routes.js';
import { resetRoutes } from './routes/reset-routes.js';
import { competitionRoutes } from './routes/competition-routes.js';

/**
 * Fastify instances are decorated with the wired {@link AppContext}, so every
 * route plugin reads the domain services and broker from `this.appContext`
 * rather than importing globals. Declared on the module augmentation below.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** The wired application object graph shared by all route plugins. */
    readonly appContext: AppContext;
  }
}

/** Prefix under which every REST/SSE endpoint is registered. */
export const API_PREFIX = '/api';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /** The fully-wired application object graph the routes draw from. */
  readonly context: AppContext;
  /**
   * Absolute path to the built frontend assets (the web package's `dist`). When
   * omitted the static-asset plugin is not registered — useful for API-level
   * tests that do not exercise the SPA. When present, assets are served with a
   * fallback to `index.html` for client-side routing.
   */
  readonly staticRoot?: string;
  /** Passed through to Fastify (e.g. `{ logger: true }`). */
  readonly logger?: boolean;
}

/**
 * Register the API route plugins under {@link API_PREFIX}.
 *
 * This is the seam the endpoint subtasks slot into: 13.2 (course/player/Day 1),
 * 13.3 (score/view), and 13.4 (SSE) each add an `fastify.register(plugin)` call
 * here. Every handler reads its dependencies from `fastify.appContext`, so no
 * route needs to construct services itself.
 *
 * @param fastify The Fastify instance, already decorated with `appContext`.
 */
async function registerApiRoutes(fastify: FastifyInstance): Promise<void> {
  // Course, player, and Day 1 completion endpoints (task 13.2). Each reads
  // `fastify.appContext` for the domain service it delegates to.
  await fastify.register(courseRoutes);
  await fastify.register(playerRoutes);
  await fastify.register(day1Routes);
  // Score entry and Day 1 / Day 2 view endpoints (task 13.3). Each reads
  // `fastify.appContext` for the service/assembler it delegates to.
  await fastify.register(scoreRoutes);
  await fastify.register(viewRoutes);
  // Competition-state read (day1Complete + cutValue), used by the Score Entry
  // screen to gate Day 2 print on Day 1 completion.
  await fastify.register(competitionRoutes);
  // Real-time SSE stream of broker events (task 13.4). Reads
  // `fastify.appContext.broker` and streams framed events with Last-Event-ID
  // replay. (Requirement 10.1, 10.2, 10.3, 10.5)
  await fastify.register(eventsRoutes);
  // End-of-year competition reset (clears players + scores + Day 1 state).
  await fastify.register(resetRoutes);
}

/**
 * Register serving of the built frontend static assets with a SPA fallback.
 *
 * `@fastify/static` serves files under `staticRoot`; the `setNotFoundHandler`
 * makes any non-API GET that does not match a file resolve to `index.html`, so
 * client-side routes (Course Setup, Competition Setup, Score Entry, Viewing_-
 * Display) load the app shell rather than 404. API 404s are left untouched so
 * missing endpoints still report as errors. (Requirement 7.9)
 *
 * @param fastify The Fastify instance.
 * @param staticRoot Absolute path to the built frontend `dist` directory.
 */
async function registerStaticAssets(
  fastify: FastifyInstance,
  staticRoot: string,
): Promise<void> {
  await fastify.register(fastifyStatic, {
    root: staticRoot,
    // The SPA fallback below owns unmatched routes, so let it decide rather than
    // having the static plugin auto-serve index.html for missing files.
    wildcard: false,
  });

  // SPA fallback: any GET that is not an API route and does not map to a static
  // file returns the app shell so client-side routing can take over. Non-GET and
  // /api requests fall through to Fastify's normal 404 handling.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith(`${API_PREFIX}/`)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not Found' });
  });
}

/**
 * Build a configured Fastify instance from a wired {@link AppContext}.
 *
 * The instance is decorated with the context, has the API route plugins
 * registered under {@link API_PREFIX}, and — when a `staticRoot` is supplied —
 * serves the built frontend with a SPA fallback. The caller is responsible for
 * `listen`/`close`; this factory performs no network or database I/O itself.
 *
 * @param options The wired context plus optional static-root and logger config.
 * @returns The configured (but not yet listening) Fastify instance.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: options.logger ?? false });

  // Share the wired object graph with every route plugin. (task 13.1)
  fastify.decorate('appContext', options.context);

  // API endpoints (handlers added in tasks 13.2–13.4).
  await fastify.register(registerApiRoutes, { prefix: API_PREFIX });

  // Built frontend assets + SPA fallback, when a build directory is provided.
  if (options.staticRoot !== undefined) {
    await registerStaticAssets(fastify, options.staticRoot);
  }

  await fastify.ready();
  return fastify;
}

/**
 * Resolve the default built-frontend directory relative to this module.
 *
 * At runtime this file lives in `server/dist`; the web build output sits at
 * `web/dist` (see the web package's Vite config). This computes that path so the
 * server entrypoint can serve the frontend without a hard-coded absolute path.
 *
 * @returns The absolute path to the web package's `dist` directory.
 */
export function defaultStaticRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // server/dist -> ../../web/dist
  return resolve(here, '..', '..', 'web', 'dist');
}
