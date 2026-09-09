/**
 * CompetitionSetupService — player roster and per-day handicap management.
 *
 * This service sits on top of the {@link Repository} and owns the validation and
 * gating rules for competition setup (Requirement 2). The repository is pure
 * persistence: this layer enforces the validate-reject-retain discipline for
 * player names (length + uniqueness), per-day handicaps (integer range, stored
 * independently per day), and reports a save that did not complete when a
 * persistence write fails (retaining the last successfully stored values).
 *
 * Responsibilities (task 8.1):
 *  - `addPlayer(name)` — accept a non-empty name of 1..100 characters that does
 *    not duplicate an existing player name. On empty/too-long input reject and
 *    return the permitted length; on a duplicate reject, retain the existing
 *    player unchanged, and report the name is already in use. On success create
 *    the player (with a generated id) and return it. (2.1, 2.2, 2.3, 2.8)
 *  - `setHandicap(playerId, day, handicap)` — accept a whole integer in [0, 36];
 *    store the Day 1 and Day 2 handicaps independently so setting one never
 *    disturbs the other. On invalid input reject, retain the previously stored
 *    handicap, and return the permitted range. (2.5, 2.6, 2.7, 2.8)
 *  - `updatePlayer(playerId, details)` — persist an updated name (validated for
 *    length + uniqueness) and both per-day handicaps (validated for range), and
 *    make them available to the Stableford calculator. On persistence failure
 *    retain the last successfully stored values and report the save did not
 *    complete. (2.9, 2.10)
 *  - `markDay1Complete(cutValue)` — require a positive integer cut value; on an
 *    invalid value do not set Day_1_Complete and report it must be a positive
 *    integer. On success set Day_1_Complete, persist the cut value, and evaluate
 *    + persist CUT for every player via the RankingAndCutService. (3.1–3.9)
 *  - `reverseDay1Complete()` — clear Day_1_Complete, the cut value, and every
 *    player's CUT status, and persist the cleared state. (3.10)
 *
 * The service never mutates stored state on a rejected entry: validation runs
 * before any repository write, so a rejected name/handicap leaves the previously
 * stored value untouched (retain-on-reject). Persistence writes are wrapped so a
 * storage failure is surfaced as a "save did not complete" result rather than
 * throwing, again leaving the last stored values intact.
 */

import { randomUUID } from 'node:crypto';
import {
  HANDICAP_MAX,
  HANDICAP_MIN,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
  err,
  ok,
  type CompetitionState,
  type Day,
  type Player,
  type PlayingHandicap,
  type Result,
  type Day1StatusChangedEvent,
  type PlayerChangedEvent,
} from '@ccs/types';
import {
  aggregateStableford,
  aggregateStrokes,
  hasNROnDay,
} from './day-aggregation.js';
import {
  evaluateCut,
  rankScratch,
  rankStableford,
  type RankablePlayer,
} from './ranking-and-cut-service.js';
import type { EventBroker } from './event-broker.js';
import type { Repository } from './repository.js';

/** Human-readable permitted-length message for a player name. (Requirement 2.2) */
const PLAYER_NAME_LENGTH_MESSAGE = `Player name must be between ${PLAYER_NAME_MIN_LENGTH} and ${PLAYER_NAME_MAX_LENGTH} characters.`;

/** Human-readable permitted-range message for a playing handicap. (Requirement 2.6) */
const HANDICAP_RANGE_MESSAGE = `Playing handicap must be a whole number from ${HANDICAP_MIN} to ${HANDICAP_MAX}.`;

/** Message returned when a save could not be persisted. (Requirement 2.10) */
const SAVE_DID_NOT_COMPLETE_MESSAGE =
  'The save did not complete; the last stored values have been retained.';

/** Message returned when the cut value is not a positive integer. (Requirement 3.3) */
const CUT_VALUE_POSITIVE_INTEGER_MESSAGE =
  'The cut value must be a positive integer.';

/** Day 1 is the day the cut is evaluated over. */
const DAY_ONE: Day = 1;

/** Details accepted when updating an existing player. */
export interface PlayerUpdate {
  readonly name: string;
  readonly handicapDay1: PlayingHandicap | null;
  readonly handicapDay2: PlayingHandicap | null;
}

/** True when `value` is an integer within the inclusive [min, max] range. */
function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** True when `name` is a string whose length is within [1, 100]. (Requirement 2.1) */
function isValidNameLength(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= PLAYER_NAME_MIN_LENGTH &&
    name.length <= PLAYER_NAME_MAX_LENGTH
  );
}

/**
 * Coordinates player and handicap configuration on top of the {@link Repository},
 * enforcing the Competition Setup validation and persistence rules
 * (Requirement 2).
 */
export class CompetitionSetupService {
  private readonly repository: Repository;

  /**
   * Optional in-process event broker. When present, a `player-changed` event is
   * published after a successful player create/handicap/update persistence, and
   * a `day1-status-changed` event after a successful Day 1 complete/reverse, so
   * connected displays refresh without a manual reload; when absent, publishing
   * is skipped. (Requirement 10.1, 10.2)
   */
  private readonly broker: EventBroker | undefined;

  constructor(repository: Repository, broker?: EventBroker) {
    this.repository = repository;
    this.broker = broker;
  }

  /**
   * Validate and create a new player. (Requirements 2.1, 2.2, 2.3, 2.8)
   *
   * Accepts a non-empty name of 1..100 characters that does not duplicate an
   * existing player name. On an empty or over-length name the entry is rejected
   * and the permitted length is returned. On a name that duplicates an existing
   * player (case-sensitive, matching the stored value) the entry is rejected,
   * the existing player is retained unchanged, and a name-in-use message is
   * returned. On success a player with a generated id and both handicaps unset
   * is persisted and returned. A persistence failure is reported as a save that
   * did not complete, leaving the roster unchanged.
   *
   * @param name The candidate player name.
   * @returns Ok with the created {@link Player}, or an error carrying the
   *   permitted length, a duplicate indication, or a persistence-failure message.
   */
  addPlayer(name: string): Result<Player> {
    if (!isValidNameLength(name)) {
      // Reject empty / over-length; nothing is created (retain roster). (2.2)
      return err(PLAYER_NAME_LENGTH_MESSAGE, 'EMPTY');
    }

    // Uniqueness: reject if any existing player already holds this name. (2.3)
    const duplicate = this.repository
      .getPlayers()
      .find((player) => player.name === name);
    if (duplicate) {
      return err(`The name "${name}" is already in use.`, 'DUPLICATE');
    }

    const id = randomUUID();
    try {
      this.repository.createPlayer({ id, name });
    } catch {
      // Persistence failed: the roster is left as it was. (2.10)
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    const created = this.repository.getPlayer(id);
    if (!created) {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a player-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const createdEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId: created.id,
    };
    this.broker?.publish(createdEvent);

    return ok(created);
  }

  /**
   * Validate and persist a single day's playing handicap for a player.
   * (Requirements 2.5, 2.6, 2.7, 2.8)
   *
   * Accepts a whole integer in [0, 36]. The Day 1 and Day 2 handicaps are stored
   * independently: writing one day's value never disturbs the other day's stored
   * value. On an empty, non-integer, or out-of-range value the entry is rejected,
   * the previously stored handicap for that day is retained (no write occurs),
   * and the permitted range is returned. A persistence failure is reported as a
   * save that did not complete, leaving the last stored values intact.
   *
   * @param playerId The id of the player whose handicap is being set.
   * @param day The day (1 or 2) the handicap applies to.
   * @param handicap The candidate playing handicap.
   * @returns Ok with the updated {@link Player}, or an error carrying the
   *   permitted range, a not-found indication, or a persistence-failure message.
   */
  setHandicap(
    playerId: string,
    day: Day,
    handicap: PlayingHandicap,
  ): Result<Player> {
    if (!isIntegerInRange(handicap, HANDICAP_MIN, HANDICAP_MAX)) {
      // Reject and retain the previously stored handicap (no write). (2.6)
      return err(HANDICAP_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }

    const existing = this.repository.getPlayer(playerId);
    if (!existing) {
      return err(`No player found with id "${playerId}".`, 'NOT_FOUND');
    }

    // Store the two days independently: carry the untouched day forward. (2.7)
    const details = {
      name: existing.name,
      handicapDay1: day === 1 ? handicap : existing.handicapDay1,
      handicapDay2: day === 2 ? handicap : existing.handicapDay2,
    };

    try {
      this.repository.updatePlayerDetails(playerId, details);
    } catch {
      // Persistence failed: the stored handicaps are left as they were. (2.10)
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    const updated = this.repository.getPlayer(playerId);
    if (!updated) {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a player-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const handicapEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId,
    };
    this.broker?.publish(handicapEvent);

    return ok(updated);
  }

  /**
   * Validate and persist an updated player name and both per-day handicaps, and
   * make them available to the Stableford calculator. (Requirements 2.9, 2.10)
   *
   * The name is validated for length (1..100) and uniqueness against the other
   * players; each supplied handicap is validated against [0, 36] (null clears a
   * day's handicap). On any invalid field the entry is rejected and the stored
   * player is retained unchanged (no write occurs). On success the updated name
   * and handicaps are persisted. If persistence fails, the last successfully
   * stored values are retained and a "save did not complete" message is returned.
   *
   * @param playerId The id of the player being updated.
   * @param details The new name and per-day handicaps (null clears a handicap).
   * @returns Ok with the updated {@link Player}, or an error carrying the
   *   permitted range/length, a duplicate/not-found indication, or a
   *   persistence-failure message.
   */
  updatePlayer(playerId: string, details: PlayerUpdate): Result<Player> {
    const existing = this.repository.getPlayer(playerId);
    if (!existing) {
      return err(`No player found with id "${playerId}".`, 'NOT_FOUND');
    }

    if (!isValidNameLength(details.name)) {
      // Reject and retain the stored player unchanged (no write). (2.2)
      return err(PLAYER_NAME_LENGTH_MESSAGE, 'EMPTY');
    }

    // Uniqueness: a name may stay the same, but must not collide with another. (2.3)
    const duplicate = this.repository
      .getPlayers()
      .find(
        (player) => player.id !== playerId && player.name === details.name,
      );
    if (duplicate) {
      return err(`The name "${details.name}" is already in use.`, 'DUPLICATE');
    }

    // Each supplied handicap must be null (cleared) or a whole integer in range. (2.6)
    if (
      details.handicapDay1 !== null &&
      !isIntegerInRange(details.handicapDay1, HANDICAP_MIN, HANDICAP_MAX)
    ) {
      return err(HANDICAP_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }
    if (
      details.handicapDay2 !== null &&
      !isIntegerInRange(details.handicapDay2, HANDICAP_MIN, HANDICAP_MAX)
    ) {
      return err(HANDICAP_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }

    try {
      this.repository.updatePlayerDetails(playerId, {
        name: details.name,
        handicapDay1: details.handicapDay1,
        handicapDay2: details.handicapDay2,
      });
    } catch {
      // Persistence failed: the last stored values are retained. (2.10)
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    const updated = this.repository.getPlayer(playerId);
    if (!updated) {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a player-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const updateEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId,
    };
    this.broker?.publish(updateEvent);

    return ok(updated);
  }

  /**
   * Persist a new display order for a day's roster from an ordered list of
   * player ids. The two days are ordered independently, so this updates only the
   * given day's order column and leaves the other day untouched.
   *
   * The list is validated to be a permutation of the current roster: it must
   * contain every player exactly once and no unknown ids. On any mismatch the
   * order is rejected and the stored order is retained unchanged (no write). On
   * success the new order is persisted and a `player-changed` event is published
   * so connected surfaces (the Score Entry grid) refresh.
   *
   * @param day The day (1 or 2) whose ordering is being set.
   * @param orderedIds The player ids in the desired display order.
   * @returns Ok with the players in the new order, or an error when the id set
   *   does not match the roster or persistence fails.
   */
  reorderPlayers(day: Day, orderedIds: readonly string[]): Result<Player[]> {
    const roster = this.repository.getPlayers();
    const rosterIds = new Set(roster.map((player) => player.id));

    // The list must be a permutation of the roster: same size, no duplicates,
    // and no unknown ids. This keeps every player positioned exactly once.
    const uniqueIds = new Set(orderedIds);
    if (
      orderedIds.length !== roster.length ||
      uniqueIds.size !== orderedIds.length ||
      orderedIds.some((id) => !rosterIds.has(id))
    ) {
      return err(
        'The ordering must list every player exactly once.',
        'INVALID',
      );
    }

    try {
      this.repository.setPlayerOrder(day, orderedIds);
    } catch {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Fan out a player-changed event so connected displays / the grid refresh
    // without a manual reload. (10.1, 10.2)
    const reorderEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId: orderedIds[0] ?? '',
    };
    this.broker?.publish(reorderEvent);

    return ok(this.repository.getPlayersOrdered(day));
  }

  /**
   * Mark Day 1 as complete with a cut value, then evaluate and persist each
   * player's CUT status. (Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.9)
   *
   * The cut value X must be a positive integer (>= 1). On an empty, non-integer,
   * zero, or negative value the action is rejected: the Day_1_Complete status is
   * not set, no cut is applied, and a "must be a positive integer" message is
   * returned (nothing is persisted). On success the Day 1 aggregates are
   * computed for every player (aggregate gross for Scratch Strokeplay, aggregate
   * Stableford for the Stableford competition, and the Day 1 No_Return
   * predicate), the two competitions are ranked, the cut is evaluated, and the
   * Day_1_Complete status, cut value, and every player's CUT status are
   * persisted. Players with a Day 1 No_Return are always cut; a player advances
   * (uncut) when their position is within the top X in either competition, and
   * is cut when their position is greater than X in both.
   *
   * @param cutValue The cut threshold X entered by the administrator.
   * @returns Ok with the resulting {@link CompetitionState}, or an error carrying
   *   the "must be a positive integer" message when the cut value is invalid.
   */
  markDay1Complete(cutValue: number): Result<CompetitionState> {
    // Reject empty/non-integer/zero/negative: do not set Day_1_Complete. (3.2, 3.3)
    if (
      typeof cutValue !== 'number' ||
      !Number.isInteger(cutValue) ||
      cutValue < 1
    ) {
      return err(CUT_VALUE_POSITIVE_INTEGER_MESSAGE, 'INVALID');
    }

    const players = this.repository.getPlayers();
    const holes = this.repository.getHoles();
    const day1Scores = this.repository.getScoresForDay(DAY_ONE);

    // Derive each player's Day 1 ranking inputs. (3.4)
    const scratchInput: RankablePlayer[] = [];
    const stablefordInput: RankablePlayer[] = [];
    const hasNRDay1 = new Map<string, boolean>();
    for (const player of players) {
      const aggregation = {
        player,
        day: DAY_ONE,
        scores: day1Scores,
        holes,
      };
      const nr = hasNROnDay(aggregation);
      hasNRDay1.set(player.id, nr);
      scratchInput.push({
        playerId: player.id,
        value: aggregateStrokes(aggregation),
        hasNRDay1: nr,
      });
      stablefordInput.push({
        playerId: player.id,
        value: aggregateStableford(aggregation),
        hasNRDay1: nr,
      });
    }

    // Rank both competitions and evaluate the cut. (3.4, 3.5, 3.6, 3.7)
    const scratchPositions = rankScratch(scratchInput);
    const stablefordPositions = rankStableford(stablefordInput);
    const autoCut = evaluateCut(
      cutValue,
      scratchPositions,
      stablefordPositions,
      hasNRDay1,
    );

    // The effective cut is the automatic cut OR the administrator's manual
    // override, so a player marked to not return for Day 2 stays cut even if the
    // algorithm would advance them. The manual override is preserved separately
    // and survives this re-evaluation.
    const cutByPlayer = new Map<string, boolean>();
    for (const player of players) {
      cutByPlayer.set(
        player.id,
        (autoCut.get(player.id) ?? false) || player.manualCut,
      );
    }

    // Persist the completion state and every player's CUT status. (3.9)
    try {
      this.repository.setCompetitionState({
        day1Complete: true,
        cutValue,
      });
      this.repository.setPlayerCuts(cutByPlayer);
    } catch {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a day1-status-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const completeEvent: Omit<Day1StatusChangedEvent, 'id'> = {
      type: 'day1-status-changed',
      day1Complete: true,
    };
    this.broker?.publish(completeEvent);

    return ok(this.repository.getCompetitionState());
  }

  /**
   * Set a player's manual-cut override — used for a player who will not return
   * for Day 2 even if they made the cut. (Manual Day 2 withdrawal)
   *
   * The override persists across Day 1 completion/reversal. The effective `cut`
   * flag (what every consumer reads to suppress Day 2) is recomputed as the
   * manual override OR the current automatic Day 1 cut, so:
   *  - turning the override ON always cuts the player;
   *  - turning it OFF returns the player to whatever the automatic cut says
   *    (still cut if the Day 1 algorithm cut them; otherwise reinstated).
   *
   * @param playerId The player whose override is being set.
   * @param manualCut Whether to manually cut (true) or clear the override (false).
   * @returns Ok with the updated {@link Player}, or an error when the player is
   *   not found or persistence fails.
   */
  setManualCut(playerId: string, manualCut: boolean): Result<Player> {
    const existing = this.repository.getPlayer(playerId);
    if (!existing) {
      return err(`No player found with id "${playerId}".`, 'NOT_FOUND');
    }

    // Effective cut = manual override OR the current automatic Day 1 cut. The
    // automatic cut is only meaningful once Day 1 is complete; otherwise there
    // is no auto cut and the effective cut is driven solely by the override.
    const autoCut = manualCut ? false : this.currentAutoCutFor(playerId);
    const effectiveCut = manualCut || autoCut;

    try {
      this.repository.setPlayerManualCut(playerId, manualCut, effectiveCut);
    } catch {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    const updated = this.repository.getPlayer(playerId);
    if (!updated) {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Fan out a player-changed event so the Day 2 display refreshes (the cut
    // player drops out of scoring/leaderboard). (10.1, 10.2)
    const cutEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId,
    };
    this.broker?.publish(cutEvent);

    return ok(updated);
  }

  /**
   * Recompute whether a single player is cut by the automatic Day 1 evaluation
   * (ignoring any manual override). Returns false when Day 1 is not complete
   * (no automatic cut applies yet). Used when clearing a manual cut to decide
   * whether the player should remain cut on Day 1 merit alone.
   */
  private currentAutoCutFor(playerId: string): boolean {
    const state = this.repository.getCompetitionState();
    if (!state.day1Complete || state.cutValue === null) {
      return false;
    }

    const players = this.repository.getPlayers();
    const holes = this.repository.getHoles();
    const day1Scores = this.repository.getScoresForDay(DAY_ONE);

    const scratchInput: RankablePlayer[] = [];
    const stablefordInput: RankablePlayer[] = [];
    const hasNRDay1 = new Map<string, boolean>();
    for (const player of players) {
      const aggregation = { player, day: DAY_ONE, scores: day1Scores, holes };
      const nr = hasNROnDay(aggregation);
      hasNRDay1.set(player.id, nr);
      scratchInput.push({
        playerId: player.id,
        value: aggregateStrokes(aggregation),
        hasNRDay1: nr,
      });
      stablefordInput.push({
        playerId: player.id,
        value: aggregateStableford(aggregation),
        hasNRDay1: nr,
      });
    }

    const autoCut = evaluateCut(
      state.cutValue,
      rankScratch(scratchInput),
      rankStableford(stablefordInput),
      hasNRDay1,
    );
    return autoCut.get(playerId) ?? false;
  }

  /**
   * Reverse the Day 1 complete action: clear the Day_1_Complete status, clear
   * the cut value, clear CUT status from every player, and persist the cleared
   * statuses. (Requirement 3.10)
   *
   * @returns Ok with the cleared {@link CompetitionState}, or an error when
   *   persistence fails.
   */
  reverseDay1Complete(): Result<CompetitionState> {
    // Clear every player's automatic CUT flag alongside the competition state,
    // but preserve any manual-cut override: a player marked to not return for
    // Day 2 stays cut even after the Day 1 cut is reversed. (3.10)
    const cleared = new Map<string, boolean>(
      this.repository.getPlayers().map((player) => [player.id, player.manualCut]),
    );

    try {
      this.repository.setCompetitionState({
        day1Complete: false,
        cutValue: null,
      });
      this.repository.setPlayerCuts(cleared);
    } catch {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Persistence succeeded: fan out a day1-status-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const reverseEvent: Omit<Day1StatusChangedEvent, 'id'> = {
      type: 'day1-status-changed',
      day1Complete: false,
    };
    this.broker?.publish(reverseEvent);

    return ok(this.repository.getCompetitionState());
  }

  /**
   * Reset the competition to a blank canvas for reuse in a new year: clear all
   * players and their scores and reset the Day 1 completion status and cut
   * value. The course configuration (18 holes' par / stroke index) is kept by
   * default, since the course is usually unchanged year to year; pass
   * `resetCourse: true` to also clear it.
   *
   * This is a destructive, irreversible bulk operation intended to run only
   * after a competition is complete and confirmed. It runs in a single
   * transaction (all-or-nothing) and, on success, publishes `player-changed` and
   * `day1-status-changed` events so every connected display refreshes to the
   * empty state.
   *
   * @param resetCourse When true, also clears every hole's par and stroke index.
   * @returns Ok with the cleared {@link CompetitionState}, or an error when
   *   persistence fails.
   */
  resetCompetition(resetCourse = false): Result<CompetitionState> {
    try {
      this.repository.resetCompetition(resetCourse);
    } catch {
      return err(SAVE_DID_NOT_COMPLETE_MESSAGE, 'PERSISTENCE_FAILED');
    }

    // Fan out events so every connected surface refreshes to the blank state:
    // player-changed clears the rosters/grids; day1-status-changed clears any
    // completion banner.
    const playerEvent: Omit<PlayerChangedEvent, 'id'> = {
      type: 'player-changed',
      playerId: '',
    };
    const day1Event: Omit<Day1StatusChangedEvent, 'id'> = {
      type: 'day1-status-changed',
      day1Complete: false,
    };
    this.broker?.publish(playerEvent);
    this.broker?.publish(day1Event);

    return ok(this.repository.getCompetitionState());
  }
}
