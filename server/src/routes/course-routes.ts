/**
 * Course configuration REST endpoints (task 13.2).
 *
 * These handlers expose the {@link CourseSetupService} over HTTP. They own no
 * validation of their own: par range (3..6), stroke-index range (1..18) plus
 * uniqueness (identifying the conflicting hole), and retain-on-reject are all
 * enforced by the service, and the service's {@link Result} is translated to an
 * HTTP reply by {@link sendResult}. The plugin reads its single dependency —
 * the wired `courseSetup` service — off `fastify.appContext`.
 *
 * Endpoints:
 *  - `GET  /course/holes`  — all 18 holes with current par/stroke index. (1.1)
 *  - `PUT  /course/holes`  — set a hole's par and/or stroke index, returning the
 *    service validation result/message (permitted ranges, duplicate stroke-index
 *    conflict) and retaining the stored value on rejection. (1.2–1.6)
 *  - `GET  /course/status` — course completeness indicator. (1.8, 1.9)
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective paths are `/api/course/holes` and `/api/course/status`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { err, type HoleOrdinal, type Par, type StrokeIndex } from '@ccs/types';
import { sendResult } from './result-response.js';

/**
 * Body accepted by `PUT /api/course/holes`: identifies the hole and carries the
 * par and/or stroke index to set. Both value fields are optional so a caller can
 * update par alone, stroke index alone, or both in one request; the field values
 * are handed to the service untouched, which owns all validation.
 */
interface PutHoleBody {
  /** The hole ordinal (1..18) being configured. */
  readonly ordinal?: unknown;
  /** The candidate par value, when updating par. */
  readonly par?: unknown;
  /** The candidate stroke index, when updating stroke index. */
  readonly strokeIndex?: unknown;
}

/**
 * Whether `value` is a number in the 1..18 hole-ordinal range. This is the one
 * check the route layer must make itself: the ordinal selects which hole the
 * service acts on (it is not a value the service validates), so a bad ordinal
 * has no service call to delegate to.
 */
function isHoleOrdinal(value: unknown): value is HoleOrdinal {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 18
  );
}

/**
 * Fastify plugin registering the course configuration endpoints.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function courseRoutes(fastify: FastifyInstance): Promise<void> {
  const { courseSetup } = fastify.appContext;

  // GET /api/course/holes — read all 18 holes. (1.1)
  fastify.get('/course/holes', async (_request, reply): Promise<FastifyReply> => {
    return reply.code(200).send(courseSetup.getHoles());
  });

  // PUT /api/course/holes — set par and/or stroke index, delegating validation
  // (ranges, uniqueness, retain-on-reject) to the service. (1.2–1.6)
  fastify.put(
    '/course/holes',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as PutHoleBody;

      if (!isHoleOrdinal(body.ordinal)) {
        return sendResult(
          reply,
          err('A hole ordinal from 1 to 18 is required.', 'OUT_OF_RANGE'),
        );
      }
      const ordinal = body.ordinal;

      // A request must set at least one of par / stroke index.
      if (body.par === undefined && body.strokeIndex === undefined) {
        return sendResult(
          reply,
          err(
            'Provide a par and/or a stroke index to set for the hole.',
            'EMPTY',
          ),
        );
      }

      // Apply par first when present; stop at the first rejection so the client
      // gets the specific message and the stored value is retained.
      if (body.par !== undefined) {
        const parResult = courseSetup.setPar(ordinal, body.par as Par);
        if (!parResult.ok) {
          return sendResult(reply, parResult);
        }
      }

      if (body.strokeIndex !== undefined) {
        const strokeIndexResult = courseSetup.setStrokeIndex(
          ordinal,
          body.strokeIndex as StrokeIndex,
        );
        if (!strokeIndexResult.ok) {
          return sendResult(reply, strokeIndexResult);
        }
      }

      // Both updates (whichever were requested) succeeded: return the hole's
      // current persisted state so the client reflects the saved values.
      const hole = courseSetup
        .getHoles()
        .find((candidate) => candidate.ordinal === ordinal);
      return reply.code(200).send(hole);
    },
  );

  // GET /api/course/status — completeness indicator with an incomplete
  // indication for the calculator gate. (1.8, 1.9)
  fastify.get('/course/status', async (_request, reply): Promise<FastifyReply> => {
    const complete = courseSetup.isCourseComplete();
    return reply.code(200).send({ complete, incomplete: !complete });
  });
}
