/**
 * Shared helper for mapping the domain {@link Result} type onto HTTP responses.
 *
 * The route layer does not re-implement any validation: every handler delegates
 * to a domain service (Course/Competition setup) which returns a
 * `Result<T>` (`ok` with a value, or an error carrying a human-readable message
 * and an optional machine-readable {@link ResultErrorCode}). This module owns
 * the single, consistent translation of that discriminated union into a Fastify
 * reply so the mapping lives in one place rather than being duplicated per
 * endpoint.
 *
 * Success (`ok`) returns HTTP 200 with the carried value serialized as JSON.
 * Failure (`err`) maps the service's error code to an appropriate HTTP status —
 * a missing player/hole is 404, everything else is a 400 validation rejection —
 * and echoes the service's message (and code) so the client can render the
 * retain-and-message feedback the requirements call for.
 */

import type { FastifyReply } from 'fastify';
import { isOk, type Result, type ResultErrorCode } from '@ccs/types';

/** Shape of the JSON body returned for a failed {@link Result}. */
export interface ErrorBody {
  /** The human-readable message from the service (safe to show the user). */
  readonly error: string;
  /** The machine-readable code, when the service supplied one. */
  readonly code?: ResultErrorCode;
}

/**
 * Map a service error code onto the HTTP status that best represents it.
 *
 * A `NOT_FOUND` code (no player/hole with the given id) is a 404; every other
 * rejection is a client-side validation failure and maps to 400. The route
 * layer performs no validation of its own — it only classifies the code the
 * service already produced.
 *
 * @param code The optional error code carried by the failed result.
 * @returns The HTTP status code to reply with.
 */
function statusForCode(code: ResultErrorCode | undefined): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

/**
 * Send a Fastify reply for a domain {@link Result}.
 *
 * On success replies 200 with the carried value. On failure replies with the
 * status derived from the error code (404 for not-found, 400 otherwise) and a
 * JSON body carrying the service's message and code, so the client sees the
 * exact validation feedback (permitted ranges, duplicate conflicts, etc.) the
 * service produced.
 *
 * @param reply The Fastify reply to send on.
 * @param result The domain result to translate.
 * @returns The Fastify reply, for chaining/return from the handler.
 */
export function sendResult<T>(reply: FastifyReply, result: Result<T>): FastifyReply {
  if (isOk(result)) {
    return reply.code(200).send(result.value);
  }

  const body: ErrorBody =
    result.code === undefined
      ? { error: result.error }
      : { error: result.error, code: result.code };
  return reply.code(statusForCode(result.code)).send(body);
}
