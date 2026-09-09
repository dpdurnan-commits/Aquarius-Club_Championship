/**
 * Competition reset REST endpoint (end-of-year reuse).
 *
 * Exposes the destructive "blank canvas" reset over HTTP: clears all players and
 * scores and resets the Day 1 completion status/cut value so the app can be
 * reused for a new year. The course configuration (18 holes' par / stroke index)
 * is kept by default; the request may opt into clearing it too. All the work and
 * event fan-out live in {@link CompetitionSetupService.resetCompetition}, whose
 * {@link Result} is translated to a reply by {@link sendResult}.
 *
 * Because this is irreversible and wipes the whole roster + scores, the client
 * is expected to gate it behind an explicit confirmation; the server also
 * requires a `confirm: true` flag in the body as a second safeguard against an
 * accidental call.
 *
 * Endpoint:
 *  - `POST /reset` — reset the competition to a blank canvas. Body:
 *    `{ confirm: true, resetCourse?: boolean }`.
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective path is `/api/reset`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { err } from '@ccs/types';
import { sendResult } from './result-response.js';

/**
 * Body accepted by `POST /api/reset`. `confirm` must be `true` (a deliberate
 * safeguard against an accidental reset); `resetCourse` optionally also clears
 * the hole configuration.
 */
interface ResetBody {
  /** Must be true to proceed — guards against an accidental wipe. */
  readonly confirm?: unknown;
  /** When true, also clears every hole's par and stroke index. */
  readonly resetCourse?: unknown;
}

/**
 * Fastify plugin registering the competition reset endpoint.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function resetRoutes(fastify: FastifyInstance): Promise<void> {
  const { competitionSetup } = fastify.appContext;

  // POST /api/reset — clear players + scores + competition state (blank canvas).
  fastify.post(
    '/reset',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as ResetBody;
      if (body.confirm !== true) {
        return sendResult(
          reply,
          err('Reset must be explicitly confirmed.', 'INVALID'),
        );
      }
      const resetCourse = body.resetCourse === true;
      return sendResult(reply, competitionSetup.resetCompetition(resetCourse));
    },
  );
}
