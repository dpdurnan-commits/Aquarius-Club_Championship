/**
 * Typed REST API client for the Club Championship Scoring backend (task 15.1).
 *
 * This is the single seam through which the (purely presentational) frontend
 * talks to the server. It mirrors the endpoints registered under the `/api`
 * prefix by the server's route plugins, and reuses the shared `@ccs/types`
 * domain/view shapes so request and response bodies match the server exactly:
 *  - Course:      `GET/PUT /api/course/holes`, `GET /api/course/status`
 *  - Players:     `GET/POST/PUT /api/players`
 *  - Day 1:       `POST /api/day1/complete`, `DELETE /api/day1/complete`
 *  - Scores:      `POST /api/scores`
 *  - View:        `GET /api/view/day1`, `GET /api/view/day2`
 *  - Events (SSE): `GET /api/events` — handled by the SSE hook (task 15.2), not here.
 *
 * The server follows a validate-reject-retain discipline: a rejected request
 * returns a non-2xx status with a JSON `{ error, code? }` body (see the server's
 * `sendResult`/`ErrorBody`), while a successful request returns the carried
 * value as JSON. This client surfaces both outcomes as a {@link Result<T>} so
 * callers handle the error branch explicitly — the same discriminated union the
 * server's services use — rather than throwing for expected validation
 * failures. Only genuinely unexpected transport/parse failures are mapped to a
 * `PERSISTENCE_FAILED` error result.
 */

import {
  err,
  ok,
  type CellState,
  type Day,
  type Day1View,
  type Day2View,
  type Hole,
  type HoleOrdinal,
  type Par,
  type Player,
  type PlayingHandicap,
  type Result,
  type ResultErrorCode,
  type StrokeIndex,
} from '@ccs/types';

/** The NR token a scorer submits to record a No_Return for a hole. */
export const NR_TOKEN = 'NR' as const;

/**
 * The token a scorer submits to clear a cell back to unrecorded, removing a
 * mistaken entry. The server also accepts null / empty string as a clear.
 */
export const CLEAR_TOKEN = 'CLEAR' as const;

/**
 * The set of values a scorer may submit for a cell: an integer 1..20, `NR`, or
 * `CLEAR` to remove an existing entry.
 */
export type ScoreSubmission = number | typeof NR_TOKEN | typeof CLEAR_TOKEN;

/**
 * Course completeness indicator returned by `GET /api/course/status`. Mirrors
 * the server's `{ complete, incomplete }` body. (Requirements 1.8, 1.9)
 */
export interface CourseStatus {
  readonly complete: boolean;
  readonly incomplete: boolean;
}

/**
 * Body for `PUT /api/course/holes`. Identifies the hole and carries the par
 * and/or stroke index to set; the server validates ranges/uniqueness and
 * retains the stored value on rejection. (Requirements 1.2–1.6)
 */
export interface PutHoleRequest {
  readonly ordinal: HoleOrdinal;
  readonly par?: Par;
  readonly strokeIndex?: StrokeIndex;
}

/** Body for `POST /api/players`: the candidate player name. (Requirement 2.1) */
export interface AddPlayerRequest {
  readonly name: string;
}

/**
 * Body for `PUT /api/players`: the player id, new name, and both per-day
 * handicaps. A `null` handicap clears that day's value. (Requirements 2.5–2.9)
 */
export interface UpdatePlayerRequest {
  readonly id: string;
  readonly name: string;
  readonly handicapDay1: PlayingHandicap | null;
  readonly handicapDay2: PlayingHandicap | null;
}

/**
 * Body for `PUT /api/players/order`: the day whose ordering is being set and the
 * player ids in the desired display order. The server validates the list is a
 * permutation of the roster and persists that day's order independently of the
 * other day. (Score Entry grid ordering)
 */
export interface ReorderPlayersRequest {
  readonly day: Day;
  readonly orderedIds: readonly string[];
}

/**
 * Body for `PUT /api/players/cut`: the player id and whether to manually cut
 * them from Day 2. The override persists across Day 1 completion/reversal.
 */
export interface SetPlayerCutRequest {
  readonly id: string;
  readonly manualCut: boolean;
}

/**
 * Body for `POST /api/scores`: identifies the cell and carries the submitted
 * value (a numeric gross 1..20 or the `NR` token). (Requirements 7.3–7.14)
 */
export interface SubmitScoreRequest {
  readonly playerId: string;
  readonly day: Day;
  readonly ordinal: HoleOrdinal;
  readonly value: ScoreSubmission;
}

/**
 * Confirmation returned by a successful `POST /api/scores`. Mirrors the server's
 * `ScoreConfirmation`: the targeted cell and the persisted state. (Requirement
 * 7.7)
 */
export interface ScoreConfirmation {
  readonly playerId: string;
  readonly day: Day;
  readonly ordinal: HoleOrdinal;
  readonly state: CellState;
}

/** The JSON body the server sends for a rejected request (its `ErrorBody`). */
interface ErrorBody {
  readonly error?: unknown;
  readonly code?: unknown;
}

/** Message used when the server response cannot be reached or parsed. */
const NETWORK_ERROR_MESSAGE =
  'Could not reach the server. Please check your connection and try again.';

/**
 * Configuration for constructing an {@link ApiClient}. `baseUrl` is prepended to
 * every request path (default `/api`, matching the server's `API_PREFIX`), and
 * `fetchImpl` allows injecting a fetch for tests. (Requirement 7.9)
 */
export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A minimal typed client over the REST API. Each method returns a
 * {@link Result} so callers branch on `ok` explicitly for the validation
 * feedback the server produces (permitted ranges, duplicate conflicts,
 * player-cut, etc.). Construct one instance and share it across screens.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api';
    // Bind so a passed reference (e.g. window.fetch) keeps its receiver.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  // ----- Course (Requirement 1) -------------------------------------------

  /** `GET /api/course/holes` — all 18 holes with current par/stroke index. */
  getHoles(): Promise<Result<readonly Hole[]>> {
    return this.request<readonly Hole[]>('GET', '/course/holes');
  }

  /**
   * `PUT /api/course/holes` — set a hole's par and/or stroke index. On success
   * returns the hole's persisted state; on rejection returns the server's
   * message (permitted range / conflicting hole ordinal). (1.2–1.6)
   */
  putHole(body: PutHoleRequest): Promise<Result<Hole>> {
    return this.request<Hole>('PUT', '/course/holes', body);
  }

  /** `GET /api/course/status` — course completeness indicator. (1.8, 1.9) */
  getCourseStatus(): Promise<Result<CourseStatus>> {
    return this.request<CourseStatus>('GET', '/course/status');
  }

  // ----- Players (Requirement 2) ------------------------------------------

  /** `GET /api/players` — list all players. */
  getPlayers(): Promise<Result<readonly Player[]>> {
    return this.request<readonly Player[]>('GET', '/players');
  }

  /**
   * `POST /api/players` — add a player by name; the server validates length
   * (1..100) and uniqueness and returns the created player. (2.1, 2.2, 2.3)
   */
  addPlayer(body: AddPlayerRequest): Promise<Result<Player>> {
    return this.request<Player>('POST', '/players', body);
  }

  /**
   * `PUT /api/players` — update a player's name and both per-day handicaps; the
   * server validates name and handicap ranges (per-day independence). (2.5–2.9)
   */
  updatePlayer(body: UpdatePlayerRequest): Promise<Result<Player>> {
    return this.request<Player>('PUT', '/players', body);
  }

  /**
   * `PUT /api/players/order` — persist a day's display order from an ordered
   * list of player ids. Day 1 and Day 2 orderings are independent; the server
   * validates the list is a permutation of the roster and returns the players
   * in the new order for that day. (Score Entry grid ordering)
   */
  reorderPlayers(body: ReorderPlayersRequest): Promise<Result<readonly Player[]>> {
    return this.request<readonly Player[]>('PUT', '/players/order', body);
  }

  /**
   * `PUT /api/players/cut` — set a player's manual-cut override (a player who
   * will not return for Day 2). The server recomputes the effective cut and
   * returns the updated player; the override persists across Day 1
   * completion/reversal. (Manual Day 2 withdrawal)
   */
  setPlayerCut(body: SetPlayerCutRequest): Promise<Result<Player>> {
    return this.request<Player>('PUT', '/players/cut', body);
  }

  // ----- Reset (end-of-year reuse) ----------------------------------------

  /**
   * `POST /api/reset` — clear all players and scores and reset the Day 1
   * completion state, returning the app to a blank canvas for a new year. The
   * course configuration is kept unless `resetCourse` is true. `confirm` must be
   * true; the destructive action is expected to be gated behind an explicit
   * confirmation in the UI as well.
   */
  resetCompetition(resetCourse = false): Promise<Result<void>> {
    return this.request<void>('POST', '/reset', { confirm: true, resetCourse });
  }

  // ----- Day 1 completion / cut (Requirement 3) ----------------------------

  /**
   * `POST /api/day1/complete` — mark Day 1 complete with a cut value; the server
   * gates on a positive integer and evaluates/persists CUT. (3.1, 3.2, 3.3, 3.9)
   */
  completeDay1(cutValue: number): Promise<Result<void>> {
    return this.request<void>('POST', '/day1/complete', { cutValue });
  }

  /** `DELETE /api/day1/complete` — reverse Day 1 completion. (3.10) */
  reverseDay1(): Promise<Result<void>> {
    return this.request<void>('DELETE', '/day1/complete');
  }

  // ----- Scores (Requirement 7) -------------------------------------------

  /**
   * `POST /api/scores` — submit a numeric gross (1..20) or `NR` for one cell;
   * the server validates the range/NR/replacement/CUT rules. (7.3–7.14)
   */
  submitScore(body: SubmitScoreRequest): Promise<Result<ScoreConfirmation>> {
    return this.request<ScoreConfirmation>('POST', '/scores', body);
  }

  // ----- Views (Requirements 8, 9) ----------------------------------------

  /** `GET /api/view/day1` — the assembled Day 1 snapshot. (Requirement 8) */
  getDay1View(): Promise<Result<Day1View>> {
    return this.request<Day1View>('GET', '/view/day1');
  }

  /** `GET /api/view/day2` — the assembled Day 2 snapshot. (Requirement 9) */
  getDay2View(): Promise<Result<Day2View>> {
    return this.request<Day2View>('GET', '/view/day2');
  }

  /**
   * The absolute URL of the SSE stream (`/api/events`). The SSE hook (task 15.2)
   * owns the `EventSource`; the client only exposes the resolved path so the
   * base URL stays configured in one place. (Requirement 10.1)
   */
  eventsUrl(): string {
    return `${this.baseUrl}/events`;
  }

  /**
   * Issue a request and translate the response into a {@link Result}. A 2xx
   * response resolves to `ok` with the parsed JSON value (or `undefined` for an
   * empty body); a non-2xx response resolves to an error carrying the server's
   * message and code; a transport/parse failure resolves to a
   * `PERSISTENCE_FAILED` error so callers never have to catch.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Result<T>> {
    const init: RequestInit =
      body === undefined
        ? { method, headers: { Accept: 'application/json' } }
        : {
            method,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch {
      return err(NETWORK_ERROR_MESSAGE, 'PERSISTENCE_FAILED');
    }

    const payload = await this.readJson(response);

    if (!response.ok) {
      return this.toError(payload);
    }

    return ok(payload as T);
  }

  /**
   * Parse a JSON response body, tolerating an empty body (204/empty 200) by
   * returning `undefined`. A malformed body on an otherwise-OK response is also
   * treated as `undefined` so `void` endpoints resolve cleanly.
   */
  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (text.trim() === '') {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * Build an error {@link Result} from a rejected response's parsed body,
   * preserving the server's human-readable message and machine-readable code
   * where present, and falling back to a generic message otherwise.
   */
  private toError(payload: unknown): Result<never> {
    const bodyObject =
      typeof payload === 'object' && payload !== null
        ? (payload as ErrorBody)
        : {};
    const message =
      typeof bodyObject.error === 'string'
        ? bodyObject.error
        : 'The request was rejected by the server.';
    const code =
      typeof bodyObject.code === 'string'
        ? (bodyObject.code as ResultErrorCode)
        : undefined;
    return err(message, code);
  }
}

/**
 * A shared default client instance targeting the same-origin `/api` prefix,
 * suitable for the frontend served by the backend (Requirement 7.9). Tests and
 * alternative hosts can construct their own {@link ApiClient} with options.
 */
export const apiClient = new ApiClient();
