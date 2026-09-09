/**
 * Competition-state REST endpoint.
 *
 * Exposes a read of the singleton competition state (`day1Complete` +
 * `cutValue`) so the frontend can determine, on load, whether Day 1 has been
 * completed. This is the source of truth the Score Entry screen needs to gate
 * the Day 2 print action (Day 2 sheets cannot be printed until Day 1 is
 * complete), independent of the transient SSE `day1-status-changed` signal.
 *
 * No logic lives here beyond reading the persisted state via the repository off
 * `fastify.appContext`. Registered under the `/api` prefix by
 * `registerApiRoutes` in `app.ts`, so the effective path is
 * `/api/competition/state`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Fastify plugin registering the competition-state read endpoint.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function competitionRoutes(fastify: FastifyInstance): Promise<void> {
  const { repository } = fastify.appContext;

  // GET /api/competition/state — the singleton { day1Complete, cutValue }.
  fastify.get('/competition/state', async (_request, reply): Promise<FastifyReply> => {
    return reply.code(200).send(repository.getCompetitionState());
  });
}
