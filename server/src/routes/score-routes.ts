/**
 * Score entry REST endpoint (task 13.3).
 *
 * This handler exposes the {@link ScoreEntryService} over HTTP. It owns no
 * scoring validation of its own: the gross range (1..20), the NR handling, the
 * per-cell last-write-wins replacement, and the CUT-player Day 2 rejection are
 * all enforced by the service, whose {@link Result} is translated to a reply by
 * {@link sendResult}. The route layer only normalises the request-body shape —
 * distinguishing the NR token from a numeric gross and rejecting a missing
 * playerId / day / ordinal before there is anything to delegate — then hands the
 * submission to `scoreEntry.submitScore`. The plugin reads the wired
 * `scoreEntry` service off `fastify.appContext`.
 *
 * Endpoint:
 *  - `POST /scores` — submit a numeric gross (1..20), `NR`, or a clear request
 *    (null / empty / `CLEAR`) for a single cell, delegating range/NR/clear/
 *    replacement/CUT validation to the service. (7.3, 7.4, 7.5, 7.6, 7.11,
 *    7.12, 7.14, score correction)
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective path is `/api/scores`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { err, type Day, type HoleOrdinal } from '@ccs/types';
import {
  CLEAR_TOKEN,
  NR_TOKEN,
  type ScoreSubmission,
} from '../score-entry-service.js';
import { sendResult } from './result-response.js';

/**
 * Body accepted by `POST /api/scores`: identifies the cell (player, day, hole)
 * and carries the submitted value. `value` is either a numeric gross or the NR
 * token; only the shape is normalised here, the range/NR semantics are the
 * service's.
 */
interface SubmitScoreBody {
  /** The id of the player being scored. */
  readonly playerId?: unknown;
  /** The day (1 or 2) the score applies to. */
  readonly day?: unknown;
  /** The hole ordinal (1..18) the score applies to. */
  readonly ordinal?: unknown;
  /** The submitted gross strokes (1..20) or the `NR` token. */
  readonly value?: unknown;
}

/** Whether `value` is a valid day selector (1 or 2). */
function isDay(value: unknown): value is Day {
  return value === 1 || value === 2;
}

/** Whether `value` is a number in the 1..18 hole-ordinal range. */
function isHoleOrdinal(value: unknown): value is HoleOrdinal {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 18
  );
}

/**
 * Whether `value` is the NR token. Matches the token case-insensitively so a
 * client may send "NR" or "nr"; the numeric range check stays with the service.
 */
function isNRToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === NR_TOKEN;
}

/**
 * Whether `value` requests clearing the cell: the CLEAR token (any case), or an
 * explicit null / empty string. A cleared cell is removed (score correction).
 */
function isClearToken(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.toUpperCase() === CLEAR_TOKEN;
}

/**
 * Fastify plugin registering the score entry endpoint.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function scoreRoutes(fastify: FastifyInstance): Promise<void> {
  const { scoreEntry } = fastify.appContext;

  // POST /api/scores — submit a numeric gross or NR for one cell, delegating
  // range/NR/replacement/CUT validation to the service. (7.3–7.6, 7.11, 7.12,
  // 7.14)
  fastify.post(
    '/scores',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as SubmitScoreBody;

      // The cell coordinates select which cell the service acts on, so a missing
      // or malformed one has no service call to delegate to and is rejected here.
      if (typeof body.playerId !== 'string') {
        return sendResult(reply, err('A player id is required.', 'NOT_FOUND'));
      }
      if (!isDay(body.day)) {
        return sendResult(reply, err('A day of 1 or 2 is required.', 'INVALID'));
      }
      if (!isHoleOrdinal(body.ordinal)) {
        return sendResult(
          reply,
          err('A hole ordinal from 1 to 18 is required.', 'OUT_OF_RANGE'),
        );
      }

      // Normalise the value shape: a clear request (null / empty / CLEAR) routes
      // to the clear branch, the NR token routes to the NR branch, and any other
      // value is passed through as a numeric candidate for the service to
      // range-check. The service owns the 1..20 validation.
      const value: ScoreSubmission = isClearToken(body.value)
        ? CLEAR_TOKEN
        : isNRToken(body.value)
          ? NR_TOKEN
          : (body.value as ScoreSubmission);

      return sendResult(
        reply,
        scoreEntry.submitScore(body.playerId, body.day, body.ordinal, value),
      );
    },
  );
}
