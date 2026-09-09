/**
 * Real-time updates SSE endpoint (task 13.4).
 *
 * This plugin exposes the in-process {@link EventBroker} as a Server-Sent Events
 * stream at `GET /api/events`. It is the one HTTP surface over which the
 * Viewing_Display receives every domain change (`score-changed`,
 * `day1-status-changed`, `course-changed`, `player-changed`) without a manual
 * reload, so aggregates/positions/relative-to-par refresh live. (Requirement
 * 10.1, 10.2, 10.3)
 *
 * SSE mechanics (Fastify v4): a persistent `text/event-stream` response must be
 * written incrementally, so the handler takes over the raw socket. It sets the
 * SSE headers, hijacks the reply (so Fastify does not try to send its own body),
 * and writes framed events directly to `reply.raw`. Each frame carries the
 * event's broker sequence `id`, its `event:` type name, and a single JSON
 * `data:` line, so the browser's `EventSource` exposes the id via
 * `Last-Event-ID` on reconnect.
 *
 * Reconnect / resync (Requirement 10.5): on connect the handler reads the
 * `Last-Event-ID` header (Fastify lowercases header names). When it names a
 * valid position, buffered events with a greater id are replayed *before* the
 * live subscription is attached, so no update persisted during the interruption
 * is dropped. When the broker reports the position has been evicted (a `null`
 * replay), a `resync` control event is emitted instead so the client can pull a
 * fresh snapshot.
 *
 * Liveness + cleanup: a periodic heartbeat comment (`: heartbeat\n\n`) keeps the
 * connection warm and lets both ends notice a dead peer. When the request
 * closes, the broker subscription is detached and the heartbeat interval is
 * cleared to avoid leaking listeners/timers.
 *
 * Registered (without a sub-prefix) under the `/api` prefix by
 * `registerApiRoutes` in `app.ts`, so the effective path is `/api/events`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DomainEvent } from '@ccs/types';

/**
 * Interval between heartbeat comment lines, in milliseconds. Comfortably inside
 * the 10-second connection-interruption detection budget (Requirement 10.4)
 * while staying quiet enough not to spam idle connections.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Serialize a domain event as a single SSE frame.
 *
 * The frame is `id:` (the broker sequence id, surfaced to the client as
 * `Last-Event-ID`), `event:` (the discriminated event type), and one `data:`
 * line carrying the JSON payload, terminated by the blank line the SSE spec
 * requires between events.
 *
 * @param event The id-stamped domain event to encode.
 * @returns The wire-format SSE frame.
 */
function formatEventFrame(event: DomainEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse a `Last-Event-ID` header value into a non-negative integer sequence id.
 *
 * A missing, empty, or malformed value yields `null`, meaning "no resync cursor"
 * — the client is treated as fresh and simply receives live events from now on.
 *
 * @param raw The raw header value (string, array, or undefined).
 * @returns The parsed non-negative integer id, or `null` when absent/invalid.
 */
function parseLastEventId(raw: string | string[] | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  // Fastify may surface a repeated header as an array; take the first value.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

/**
 * Fastify plugin registering the SSE `/api/events` endpoint.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  const { broker } = fastify.appContext;

  // GET /api/events — subscribe to the live broker stream. (Requirement 10.1)
  fastify.get('/events', (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const raw = reply.raw;

    // Establish the SSE stream: text/event-stream, no caching/buffering, and a
    // kept-alive connection the client's EventSource holds open.
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Defeat proxy response buffering (e.g. nginx) so frames flush promptly.
      'X-Accel-Buffering': 'no',
    });

    // Take over the response so Fastify does not attempt to serialize a body.
    reply.hijack();

    // Resync on reconnect: replay buffered events the client missed before
    // attaching the live subscription, so no persisted update is lost. When the
    // requested position has been evicted, tell the client to pull a fresh
    // snapshot instead. (Requirement 10.5)
    const lastEventId = parseLastEventId(request.headers['last-event-id']);
    if (lastEventId !== null) {
      const missed = broker.replayAfter(lastEventId);
      if (missed === null) {
        // The client's position is older than the retained window: incremental
        // replay is impossible, so signal a full snapshot resync.
        raw.write('event: resync\ndata: {"reason":"buffer-evicted"}\n\n');
      } else {
        for (const event of missed) {
          raw.write(formatEventFrame(event));
        }
      }
    }

    // Live subscription: fan every subsequent event out to this connection.
    const unsubscribe = broker.subscribe((event) => {
      raw.write(formatEventFrame(event));
    });

    // Heartbeat comment lines keep the connection warm and surface a dead peer.
    const heartbeat = setInterval(() => {
      raw.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);
    // Do not let the heartbeat timer keep the process alive on shutdown.
    heartbeat.unref?.();

    // Clean up on disconnect: detach the broker listener and stop the heartbeat
    // so neither leaks after the client goes away.
    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });

    return reply;
  });
}
