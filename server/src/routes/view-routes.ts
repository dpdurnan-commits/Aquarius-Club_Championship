/**
 * Viewing/display REST endpoints (task 13.3).
 *
 * These handlers expose the {@link ScoresDisplayAssembler} over HTTP. The
 * assembler recomputes a render-ready snapshot on every read (Stableford points,
 * aggregates, competition positions, relative-to-par, and NR handling are all
 * derived server-side), so the client stays purely presentational. No logic
 * lives here beyond calling the assembler and returning its snapshot as JSON;
 * the plugin reads the wired `assembler` off `fastify.appContext`.
 *
 * Endpoints:
 *  - `GET /view/day1` — the Day 1 view snapshot. (Requirement 8, 8.1)
 *  - `GET /view/day2` — the Day 2 view snapshot. (Requirement 9, 9.1)
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective paths are `/api/view/day1` and `/api/view/day2`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Fastify plugin registering the Day 1 / Day 2 view endpoints.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function viewRoutes(fastify: FastifyInstance): Promise<void> {
  const { assembler } = fastify.appContext;

  // GET /api/view/day1 — the assembled Day 1 snapshot. (Requirement 8)
  fastify.get('/view/day1', async (_request, reply): Promise<FastifyReply> => {
    return reply.code(200).send(assembler.buildDay1View());
  });

  // GET /api/view/day2 — the assembled Day 2 snapshot. (Requirement 9)
  fastify.get('/view/day2', async (_request, reply): Promise<FastifyReply> => {
    return reply.code(200).send(assembler.buildDay2View());
  });
}
