/**
 * Player and handicap REST endpoints (task 13.2).
 *
 * These handlers expose the roster/handicap surface of the
 * {@link CompetitionSetupService} over HTTP. As with the course routes, no
 * validation lives here: name length (1..100) + uniqueness, handicap range
 * (0..36) with per-day independence, and retain-on-reject are all enforced by
 * the service, whose {@link Result} is translated to a reply by
 * {@link sendResult}. The plugin reads the wired `competitionSetup` service and
 * the `repository` (for the list read) off `fastify.appContext`.
 *
 * Endpoints:
 *  - `GET  /players` — list all players. (2)
 *  - `POST /players` — add a player by name, delegating length/uniqueness
 *    validation to the service. (2.1, 2.2, 2.3)
 *  - `PUT  /players` — update a player's name and per-day handicaps, delegating
 *    name and handicap-range validation (per-day independence) to the service.
 *    (2.5, 2.6, 2.7, 2.9)
 *
 * Registered under the `/api` prefix by `registerApiRoutes` in `app.ts`, so the
 * effective path is `/api/players`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  err,
  type Day,
  type PlayingHandicap,
} from '@ccs/types';
import type { PlayerUpdate } from '../competition-setup-service.js';
import { sendResult } from './result-response.js';

/** Body accepted by `POST /api/players`: the candidate player name. */
interface AddPlayerBody {
  /** The candidate name; length/uniqueness are validated by the service. */
  readonly name?: unknown;
}

/**
 * Body accepted by `PUT /api/players`: the player id plus the new name and both
 * per-day handicaps. A `null` handicap clears that day's value; the service
 * validates the supplied fields and stores the two days independently.
 */
interface UpdatePlayerBody {
  /** The id of the player being updated. */
  readonly id?: unknown;
  /** The new name; length/uniqueness are validated by the service. */
  readonly name?: unknown;
  /** Day 1 playing handicap, or null to clear it. */
  readonly handicapDay1?: unknown;
  /** Day 2 playing handicap, or null to clear it. */
  readonly handicapDay2?: unknown;
}

/**
 * Body accepted by `PUT /api/players/order`: the day whose ordering is being set
 * and the player ids in the desired display order. The service validates that
 * the ids form a permutation of the roster.
 */
interface ReorderPlayersBody {
  /** The day (1 or 2) whose ordering is being set. */
  readonly day?: unknown;
  /** The player ids in the desired display order. */
  readonly orderedIds?: unknown;
}

/**
 * Body accepted by `PUT /api/players/cut`: the player id and whether to manually
 * cut them from Day 2. The override persists across Day 1 completion/reversal.
 */
interface ManualCutBody {
  /** The id of the player whose manual-cut override is being set. */
  readonly id?: unknown;
  /** True to manually cut the player from Day 2; false to clear the override. */
  readonly manualCut?: unknown;
}

/**
 * Coerce a request-supplied handicap field into the `PlayingHandicap | null`
 * the service expects. Only the shape is normalised here (absent/null becomes
 * null); the numeric range (0..36) is validated by the service, so any other
 * value is passed through unchanged for the service to reject.
 */
function toHandicapField(value: unknown): PlayingHandicap | null {
  return value === undefined || value === null ? null : (value as PlayingHandicap);
}

/** Whether `value` is a valid day selector (1 or 2). */
function isDay(value: unknown): value is Day {
  return value === 1 || value === 2;
}

/** Whether `value` is an array of strings (candidate ordered id list). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Fastify plugin registering the player/handicap endpoints.
 *
 * @param fastify The Fastify instance, decorated with `appContext`.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function playerRoutes(fastify: FastifyInstance): Promise<void> {
  const { competitionSetup, repository } = fastify.appContext;

  // GET /api/players — list all players. (2)
  fastify.get('/players', async (_request, reply): Promise<FastifyReply> => {
    return reply.code(200).send(repository.getPlayers());
  });

  // POST /api/players — add a player, delegating name validation to the
  // service (length 1..100 + uniqueness). (2.1, 2.2, 2.3)
  fastify.post(
    '/players',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as AddPlayerBody;
      if (typeof body.name !== 'string') {
        return sendResult(reply, err('A player name is required.', 'EMPTY'));
      }
      return sendResult(reply, competitionSetup.addPlayer(body.name));
    },
  );

  // PUT /api/players — update name + per-day handicaps, delegating validation
  // (name length/uniqueness, handicap range, per-day independence) to the
  // service. (2.5, 2.6, 2.7, 2.9)
  fastify.put(
    '/players',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as UpdatePlayerBody;
      if (typeof body.id !== 'string') {
        return sendResult(reply, err('A player id is required.', 'NOT_FOUND'));
      }
      if (typeof body.name !== 'string') {
        return sendResult(reply, err('A player name is required.', 'EMPTY'));
      }

      const update: PlayerUpdate = {
        name: body.name,
        handicapDay1: toHandicapField(body.handicapDay1),
        handicapDay2: toHandicapField(body.handicapDay2),
      };
      return sendResult(reply, competitionSetup.updatePlayer(body.id, update));
    },
  );

  // PUT /api/players/order — persist a day's display order from an ordered id
  // list, delegating the permutation validation to the service. The two days
  // are ordered independently. (Score Entry grid ordering)
  fastify.put(
    '/players/order',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as ReorderPlayersBody;
      if (!isDay(body.day)) {
        return sendResult(reply, err('A day of 1 or 2 is required.', 'INVALID'));
      }
      if (!isStringArray(body.orderedIds)) {
        return sendResult(
          reply,
          err('An ordered list of player ids is required.', 'INVALID'),
        );
      }
      return sendResult(
        reply,
        competitionSetup.reorderPlayers(body.day, body.orderedIds),
      );
    },
  );

  // PUT /api/players/cut — set a player's manual-cut override (a player who will
  // not return for Day 2). Delegates to the service, which recomputes the
  // effective cut and preserves the override across Day 1 complete/reverse.
  fastify.put(
    '/players/cut',
    async (request: FastifyRequest, reply): Promise<FastifyReply> => {
      const body = (request.body ?? {}) as ManualCutBody;
      if (typeof body.id !== 'string') {
        return sendResult(reply, err('A player id is required.', 'NOT_FOUND'));
      }
      if (typeof body.manualCut !== 'boolean') {
        return sendResult(
          reply,
          err('A manualCut boolean is required.', 'INVALID'),
        );
      }
      return sendResult(
        reply,
        competitionSetup.setManualCut(body.id, body.manualCut),
      );
    },
  );
}
