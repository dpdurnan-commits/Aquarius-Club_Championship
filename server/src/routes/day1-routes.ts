/**
 * Day 1 completion REST endpoints (task 13.2).
 *
 * These handlers expose the Day 1 completion/reversal surface of the
 * {@link CompetitionSetupService} over HTTP. No validation lives here: the cut
 * value must be a positive integer (the completion gate), the ranking + cut
 * evaluation, CUT persistence, and the reversal that clears Day_1_Complete, the
 * cut value, and every CUT flag are all owned by the service, whose
 * {@link Result} is translated to a reply by {@link sendResult}. The plugin
 * reads the wired `competitionSetup` service off `fastify.appContext`.
 *
 * Endpoints:
 *  - `POST   /day1/complete` — mark Day 1 complete with a cut value, delegating
 *    the positive-integer gate and cut evaluation to the service. (3.1, 3.2,
 *    3.3, 3.9)
 *  - `DELETE /day1/complete` — reverse Day 1 completion. (3.10)
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective path is `/api/day1/complete`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendResult } from './result-response.js';

/**
 * Body accepted by `POST /api/day1/complete`: the cut value X. Passed to the
 * service untouched; the positive-integer requirement is validated there so an
 * invalid value does not set Day_1_Complete. (3.2, 3.3)
 */
interface CompleteDay1Body {
  /** The cut threshold X; validated as a positive integer by the service. */
  readonly cutValue?: unknown;
}

/**
 * Fastify plugin registering the Day 1 completion endpoints.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function day1Routes(fastify: FastifyInstance): Promise<void> {
  const { competitionSetup } = fastify.appContext;

  // POST /api/day1/complete — mark complete with a cut value; the service gates
  // on a positive integer and evaluates/persists CUT. (3.1, 3.2, 3.3, 3.9)
  fastify.post(
    '/day1/complete',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as CompleteDay1Body;
      // Hand the raw value to the service; it owns the positive-integer gate.
      return sendResult(
        reply,
        competitionSetup.markDay1Complete(body.cutValue as number),
      );
    },
  );

  // DELETE /api/day1/complete — reverse completion, clearing status, cut value,
  // and every CUT flag. (3.10)
  fastify.delete('/day1/complete', async (_request, reply): Promise<FastifyReply> => {
    return sendResult(reply, competitionSetup.reverseDay1Complete());
  });
}
