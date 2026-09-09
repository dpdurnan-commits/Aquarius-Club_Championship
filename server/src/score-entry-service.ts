/**
 * ScoreEntryService — scorer submissions of gross strokes or NR for a cell.
 *
 * This service sits on top of the {@link Repository} and owns the validation and
 * gating rules for score entry (Requirement 7). The repository is pure
 * persistence (per-cell last-write-wins upsert in its own transaction); this
 * layer enforces the validate-reject-retain discipline for score values, the
 * numeric/NR upsert semantics, the CUT-player Day 2 gate, and the
 * persistence-failure handling that preserves the entered value for resubmission.
 *
 * Responsibilities (task 9.1):
 *  - `submitScore(playerId, day, ordinal, value)` where `value` is an integer
 *    1..20 or the token `NR`:
 *    - Empty / non-integer / out-of-range numeric → reject, do not persist,
 *      retain the prior stored cell value unchanged, and return the permitted
 *      range 1..20. (7.3, 7.4)
 *    - Valid numeric → upsert against `(playerId, day, ordinal)`, replacing any
 *      existing numeric or NR value. (7.5, 7.6)
 *    - `NR` → upsert a No_Return status against the cell, replacing any existing
 *      numeric value or NR. (7.11, 7.12)
 *    - Recording NR on one hole of a day never blocks numeric entries on the
 *      remaining holes of that day: each submission targets exactly one cell, so
 *      per-cell independence follows from the per-cell upsert. (7.13)
 *    - A CUT player + a Day 2 submission → reject, do not persist any Day 2
 *      cell, and return a "player is cut" message. (7.14)
 *    - On success return a confirmation carrying the persisted cell state; on a
 *      persistence timeout/failure return a save-failed indication that
 *      preserves the entered value so the scorer can resubmit. (7.7, 7.8)
 *
 * The service never mutates stored state on a rejected entry: validation and the
 * CUT gate run before any repository write, so a rejected value leaves the
 * previously stored cell untouched (retain-on-reject). The persistence write is
 * wrapped so a storage failure/timeout is surfaced as a save-failed result
 * (rather than throwing), preserving the entered value for resubmission and
 * leaving the last stored value intact.
 */

import {
  GROSS_MAX,
  GROSS_MIN,
  NO_RETURN,
  UNRECORDED,
  err,
  numericCell,
  ok,
  type CellState,
  type Day,
  type Gross,
  type HoleOrdinal,
  type Result,
  type ScoreChangedEvent,
} from '@ccs/types';
import type { EventBroker } from './event-broker.js';
import type { Repository } from './repository.js';

/** The token a scorer submits to record a No_Return for a hole. (Requirement 7.11) */
export const NR_TOKEN = 'NR' as const;

/**
 * The token a scorer submits to clear a cell back to unrecorded — used to
 * correct an erroneous entry. Clearing deletes any stored numeric/NR value for
 * the cell so it reads as if no score was ever entered. (Score correction)
 */
export const CLEAR_TOKEN = 'CLEAR' as const;

/**
 * The set of values a scorer may submit: an integer 1..20, the NR token, or the
 * CLEAR token to remove an existing entry.
 */
export type ScoreSubmission = Gross | typeof NR_TOKEN | typeof CLEAR_TOKEN;

/** Day 2 is the round gated by CUT status. (Requirement 7.14) */
const DAY_TWO: Day = 2;

/** Human-readable permitted-range message for a gross-strokes value. (Requirement 7.4) */
const GROSS_RANGE_MESSAGE = `Score must be a whole number from ${GROSS_MIN} to ${GROSS_MAX}, or "${NR_TOKEN}".`;

/** Message returned when a Day 2 submission is made for a CUT player. (Requirement 7.14) */
const PLAYER_CUT_MESSAGE =
  'This player is cut and cannot receive a Day 2 score.';

/** Message returned when persistence did not complete in time. (Requirement 7.8) */
const SAVE_FAILED_MESSAGE =
  'The score was not saved. Please resubmit.';

/**
 * Confirmation returned on a successful submission. It echoes the cell the write
 * targeted and the persisted {@link CellState}, so the caller can confirm to the
 * scorer exactly what was recorded. (Requirement 7.7)
 */
export interface ScoreConfirmation {
  readonly playerId: string;
  readonly day: Day;
  readonly ordinal: HoleOrdinal;
  /** The state now persisted for the cell (numeric or NR). */
  readonly state: CellState;
}

/**
 * True when `value` is the NR token. Narrows a submission to the NR branch so
 * numeric validation only runs against numeric candidates.
 */
function isNR(value: ScoreSubmission): value is typeof NR_TOKEN {
  return value === NR_TOKEN;
}

/**
 * True when `value` is the CLEAR token. Narrows a submission to the clear branch,
 * which removes any stored value for the cell (score correction).
 */
function isClear(value: ScoreSubmission): value is typeof CLEAR_TOKEN {
  return value === CLEAR_TOKEN;
}

/** True when `value` is a whole integer within the inclusive gross range [1, 20]. */
function isValidGross(value: unknown): value is Gross {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= GROSS_MIN &&
    value <= GROSS_MAX
  );
}

/**
 * Coordinates scorer submissions on top of the {@link Repository}, enforcing the
 * Score Entry validation, upsert, CUT-gating, and persistence-failure rules
 * (Requirement 7).
 */
export class ScoreEntryService {
  private readonly repository: Repository;

  /**
   * Optional in-process event broker. When present, a `score-changed` event is
   * published after a successful cell persistence so connected displays refresh
   * without a manual reload; when absent, publishing is skipped. (Requirement
   * 10.1, 10.2)
   */
  private readonly broker: EventBroker | undefined;

  constructor(repository: Repository, broker?: EventBroker) {
    this.repository = repository;
    this.broker = broker;
  }

  /**
   * Validate and persist a scorer's submission for a single cell.
   * (Requirements 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.11, 7.12, 7.13, 7.14)
   *
   * The `value` is either an integer in [1, 20] or the token `NR`:
   *  - An empty, non-integer, or out-of-range numeric value is rejected: no
   *    write occurs, the previously stored cell is retained, and the permitted
   *    range 1..20 (or NR) is returned. (7.3, 7.4)
   *  - A valid numeric value is upserted against `(playerId, day, ordinal)`,
   *    replacing any existing numeric or NR value. (7.5, 7.6)
   *  - `NR` is upserted as a No_Return status for the cell, replacing any
   *    existing numeric value or NR. (7.11, 7.12)
   *  - `CLEAR` removes any stored value for the cell (back to unrecorded), so a
   *    mistaken entry can be corrected. (Score correction)
   *  - Because each submission targets exactly one cell, recording NR on one
   *    hole of a day never blocks numeric entries on the day's other holes. (7.13)
   *  - If the player has CUT status and the submission is for Day 2, it is
   *    rejected: no Day 2 cell is persisted and a "player is cut" message is
   *    returned. (7.14)
   *
   * On success a {@link ScoreConfirmation} carrying the persisted cell state is
   * returned. If persistence does not complete (timeout/failure), a save-failed
   * error is returned; the entered `value` is left with the caller to resubmit
   * and the last stored cell value is untouched. (7.7, 7.8)
   *
   * @param playerId The id of the player being scored.
   * @param day The day (1 or 2) the score applies to.
   * @param ordinal The hole ordinal (1..18) the score applies to.
   * @param value The submitted gross strokes (1..20) or the `NR` token.
   * @returns Ok with a {@link ScoreConfirmation}, or an error carrying the
   *   permitted range, a "player is cut" indication, a not-found indication, or
   *   a save-failed indication.
   */
  submitScore(
    playerId: string,
    day: Day,
    ordinal: HoleOrdinal,
    value: ScoreSubmission,
  ): Result<ScoreConfirmation> {
    // Validate the value up front so a rejected entry never touches storage. A
    // submission must be the NR token, the CLEAR token, or a valid gross. (7.4)
    if (!isNR(value) && !isClear(value) && !isValidGross(value)) {
      return err(GROSS_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }

    const player = this.repository.getPlayer(playerId);
    if (!player) {
      return err(`No player found with id "${playerId}".`, 'NOT_FOUND');
    }

    // A CUT player cannot receive any Day 2 numeric or NR score. Reject before
    // any write so no Day 2 cell is persisted. Clearing is also blocked on Day 2
    // for a cut player, since a cut player has no editable Day 2 card. (7.14)
    if (player.cut && day === DAY_TWO) {
      return err(PLAYER_CUT_MESSAGE, 'PLAYER_CUT');
    }

    // Numeric replaces existing (7.5, 7.6); NR replaces existing (7.11, 7.12);
    // CLEAR removes the stored value (unrecorded), correcting an error entry.
    // Each write is a per-cell upsert, so distinct cells stay independent (7.13).
    const state: CellState = isClear(value)
      ? UNRECORDED
      : isNR(value)
        ? NO_RETURN
        : numericCell(value);

    try {
      this.repository.upsertScore(playerId, day, ordinal, state);
    } catch {
      // Persistence timeout/failure: the last stored cell is untouched and the
      // scorer keeps the entered value to resubmit. (7.8)
      return err(SAVE_FAILED_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a score-changed event so every connected
    // display recomputes and refreshes without a manual reload. Emitted only on
    // this success path — never after a rejected/invalid/failed write. (10.1, 10.2)
    const event: Omit<ScoreChangedEvent, 'id'> = {
      type: 'score-changed',
      playerId,
      day,
      ordinal,
    };
    this.broker?.publish(event);

    // Confirm exactly what was persisted. (7.7)
    return ok({ playerId, day, ordinal, state });
  }
}
