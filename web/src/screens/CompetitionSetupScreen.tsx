/**
 * Competition Setup screen (task 16.2).
 *
 * The admin surface for Requirement 2 (players + per-day handicaps) and the
 * Requirement 3 mark/reverse-Day-1-complete controls. It covers: adding a
 * player by name (2.1) with the server's reject-and-message on empty / too-long
 * / duplicate names leaving the roster unchanged (2.2, 2.3); editing a player's
 * name and each day's playing handicap as independent fields (2.4, 2.7) with a
 * save confirmation on success and validate-reject-retain on rejection (2.5,
 * 2.6, 2.9); and the mark-Day-1-complete action gated on a positive-integer cut
 * value (3.1, 3.2, 3.3) plus the reverse action (3.10).
 *
 * Like {@link CourseSetupScreen}, this screen is purely presentational over the
 * server-authoritative rules: all persistence and validation live behind the
 * typed {@link ApiClient} (`GET/POST/PUT /api/players`, `POST/DELETE
 * /api/day1/complete`). Each editable field saves independently on blur/Enter;
 * a rejected field reverts to the last persisted value and shows the server's
 * message inline, never disturbing the other fields. A lightweight client-side
 * pre-check mirrors the server's accept rule (name length 1..100, handicap
 * integer 0..36, cut value a positive integer) for immediate feedback, but the
 * server remains the source of truth for uniqueness and persistence.
 *
 * There is no endpoint that reports the current Day 1 completion state, and the
 * complete/reverse calls return `Result<void>`, so the Day 1 panel is driven
 * from local component state: it tracks the last successful action and shows a
 * confirmation, rather than trying to read a status that isn't exposed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DAYS,
  HANDICAP_MAX,
  HANDICAP_MIN,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
  type Day,
  type Player,
  type PlayingHandicap,
} from '@ccs/types';
import { apiClient, type ApiClient } from '../api/client.js';

/** Return a player's order value for the given day. */
function orderForDay(player: Player, day: Day): number {
  return day === 1 ? player.orderDay1 : player.orderDay2;
}

/** Sort a roster copy by a day's display order, tie-breaking on name. */
function sortByDayOrder(players: readonly Player[], day: Day): Player[] {
  return [...players].sort((a, b) => {
    const delta = orderForDay(a, day) - orderForDay(b, day);
    return delta !== 0 ? delta : a.name.localeCompare(b.name);
  });
}

/** The editable fields of an existing player row. */
type PlayerField = 'name' | 'handicapDay1' | 'handicapDay2';

/** The permitted-range message for a handicap field, matching the server. (2.6) */
const HANDICAP_RANGE_MESSAGE = `Handicap must be an integer from ${HANDICAP_MIN} to ${HANDICAP_MAX}.`;

/** The permitted name-length message, matching the server. (2.2) */
const NAME_LENGTH_MESSAGE = `Name must be between ${PLAYER_NAME_MIN_LENGTH} and ${PLAYER_NAME_MAX_LENGTH} characters.`;

/** The cut-value message, matching the server. (3.3) */
const CUT_VALUE_MESSAGE = 'Cut value must be a positive integer.';

/** Per-field transient feedback: an inline error or a save confirmation. */
interface Feedback {
  readonly kind: 'error' | 'confirmation';
  readonly message: string;
}

/** Key uniquely identifying one editable field of one player. */
type FieldKey = `${string}:${PlayerField}`;

function fieldKey(playerId: string, field: PlayerField): FieldKey {
  return `${playerId}:${field}`;
}

/** The value a player field currently shows as a string (empty when unset). */
function playerFieldText(player: Player, field: PlayerField): string {
  switch (field) {
    case 'name':
      return player.name;
    case 'handicapDay1':
      return player.handicapDay1 === null ? '' : String(player.handicapDay1);
    case 'handicapDay2':
      return player.handicapDay2 === null ? '' : String(player.handicapDay2);
  }
}

/**
 * Parse and range-check a raw handicap string, mirroring the server's accept
 * rule. Returns the parsed integer when valid, or `null` when it must be
 * rejected (empty, non-integer, or outside 0..36). (2.5, 2.6)
 */
function parseHandicap(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < HANDICAP_MIN || parsed > HANDICAP_MAX) {
    return null;
  }
  return parsed;
}

/**
 * Validate a candidate player name client-side, mirroring the server's length
 * rule (uniqueness is server-authoritative). Returns the trimmed name when the
 * length is acceptable, or `null` otherwise. (2.1, 2.2)
 */
function validNameOrNull(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length < PLAYER_NAME_MIN_LENGTH ||
    trimmed.length > PLAYER_NAME_MAX_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

/** Parse a cut value client-side: a positive integer, else `null`. (3.3) */
function parseCutValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

/** Props for {@link CompetitionSetupScreen}. `client` is injectable for tests. */
export interface CompetitionSetupScreenProps {
  readonly client?: ApiClient;
}

/**
 * The Competition Setup screen: an add-player control, an editable roster of
 * players with per-day handicaps, and the Day 1 completion / reversal panel,
 * wired to the player and Day 1 endpoints.
 */
export function CompetitionSetupScreen({
  client = apiClient,
}: CompetitionSetupScreenProps = {}): JSX.Element {
  // The authoritative, last-persisted players (source of truth for revert).
  const [players, setPlayers] = useState<readonly Player[] | null>(null);
  // Live text for each editable field, keyed by player+field. Diverges from the
  // persisted value only while an edit is in flight.
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  // Transient per-field feedback (error or save confirmation).
  const [feedback, setFeedback] = useState<Partial<Record<FieldKey, Feedback>>>(
    {},
  );
  // A load-time transport error, shown at the top of the screen.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-player control state.
  const [newName, setNewName] = useState('');
  const [addFeedback, setAddFeedback] = useState<Feedback | null>(null);

  // Which day's display order the roster table is currently editing. The two
  // days are ordered independently (players arrive at checkpoints in a different
  // order each day), so the table shows one day's order at a time.
  const [orderDay, setOrderDay] = useState<Day>(1);
  // A transient message for the reorder action (e.g. a persistence failure).
  const [orderFeedback, setOrderFeedback] = useState<Feedback | null>(null);

  // Transient feedback + in-flight guard for the "copy Day 1 → Day 2" action.
  const [copyFeedback, setCopyFeedback] = useState<Feedback | null>(null);
  const [copying, setCopying] = useState(false);

  // Per-player transient feedback for the manual cut toggle, keyed by player id.
  const [cutFeedback, setCutFeedback] = useState<Partial<Record<string, Feedback>>>(
    {},
  );

  // End-of-year reset state: a type-to-confirm guard, an optional course-reset
  // choice, an in-flight guard, and feedback.
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetCourse, setResetCourse] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<Feedback | null>(null);

  // Day 1 completion panel state (driven locally; no status endpoint exists).
  const [cutValueText, setCutValueText] = useState('');
  const [day1Feedback, setDay1Feedback] = useState<Feedback | null>(null);

  // Initial load: fetch the roster.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.getPlayers();
      if (cancelled) return;
      if (result.ok) {
        setPlayers(result.value);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  /** The current text for a field: the live draft if present, else persisted. */
  const textFor = useCallback(
    (player: Player, field: PlayerField): string => {
      const key = fieldKey(player.id, field);
      const draft = drafts[key];
      return draft !== undefined ? draft : playerFieldText(player, field);
    },
    [drafts],
  );

  /** Record a keystroke into a field's draft and clear its stale feedback. */
  const onChangeField = useCallback(
    (playerId: string, field: PlayerField, raw: string): void => {
      const key = fieldKey(playerId, field);
      setDrafts((prev) => ({ ...prev, [key]: raw }));
      setFeedback((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  /** Discard a field's draft, reverting the input to the persisted value. */
  const revertDraft = useCallback((key: FieldKey): void => {
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** Set feedback for one field. */
  const setFieldFeedback = useCallback(
    (key: FieldKey, value: Feedback): void => {
      setFeedback((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /**
   * Add a new player by name. Client-side pre-checks the length (2.2), then
   * posts; on success the player joins the roster and the input clears (2.1),
   * on rejection the server's message is shown and the roster is unchanged
   * (2.2, 2.3).
   */
  const addPlayer = useCallback(async (): Promise<void> => {
    const candidate = validNameOrNull(newName);
    if (candidate === null) {
      setAddFeedback({ kind: 'error', message: NAME_LENGTH_MESSAGE });
      return;
    }

    const result = await client.addPlayer({ name: candidate });
    if (result.ok) {
      const added = result.value;
      setPlayers((prev) => (prev ? [...prev, added] : [added]));
      setNewName('');
      setAddFeedback({
        kind: 'confirmation',
        message: `Player "${added.name}" added.`,
      });
    } else {
      // Duplicate / too-long / empty rejected by the server: leave the roster
      // unchanged and surface the server's message. (2.2, 2.3)
      setAddFeedback({ kind: 'error', message: result.error });
    }
  }, [client, newName]);

  /**
   * Persist an edit to one field of an existing player. Because `updatePlayer`
   * requires the id, name, and BOTH handicaps, the unchanged fields are sent
   * with their current persisted values so a single-field edit never clobbers
   * the others. Client-side pre-checks first (retain + range message), then
   * persists; on success adopts the returned player, on rejection reverts and
   * shows the server's message. (2.5, 2.6, 2.7, 2.9)
   */
  const saveField = useCallback(
    async (player: Player, field: PlayerField): Promise<void> => {
      const key = fieldKey(player.id, field);
      const raw = drafts[key];
      if (raw === undefined) return;
      // Nothing changed relative to the persisted value: drop the draft.
      if (raw.trim() === playerFieldText(player, field).trim()) {
        revertDraft(key);
        return;
      }

      // Build the full update from persisted values, overriding the one field.
      let name = player.name;
      let handicapDay1: PlayingHandicap | null = player.handicapDay1;
      let handicapDay2: PlayingHandicap | null = player.handicapDay2;

      if (field === 'name') {
        const candidate = validNameOrNull(raw);
        if (candidate === null) {
          revertDraft(key);
          setFieldFeedback(key, { kind: 'error', message: NAME_LENGTH_MESSAGE });
          return;
        }
        name = candidate;
      } else {
        const parsed = parseHandicap(raw);
        if (parsed === null) {
          revertDraft(key); // retain the previously stored value (2.6)
          setFieldFeedback(key, {
            kind: 'error',
            message: HANDICAP_RANGE_MESSAGE,
          });
          return;
        }
        if (field === 'handicapDay1') {
          handicapDay1 = parsed;
        } else {
          handicapDay2 = parsed;
        }
      }

      const result = await client.updatePlayer({
        id: player.id,
        name,
        handicapDay1,
        handicapDay2,
      });

      if (result.ok) {
        const updated = result.value;
        setPlayers((prev) =>
          prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev,
        );
        revertDraft(key);
        setFieldFeedback(key, {
          kind: 'confirmation',
          message:
            field === 'name'
              ? 'Name saved.'
              : `Day ${field === 'handicapDay1' ? 1 : 2} handicap saved.`,
        });
      } else {
        // Rejected by the server (e.g. duplicate name): retain the previously
        // stored value and surface the server's message. (2.3, 2.6, 2.9)
        revertDraft(key);
        setFieldFeedback(key, { kind: 'error', message: result.error });
      }
    },
    [client, drafts, revertDraft, setFieldFeedback],
  );

  /**
   * Mark Day 1 complete with the entered cut value. Client-side pre-checks the
   * positive-integer rule (3.3), then calls the endpoint; on success shows a
   * confirmation, on rejection surfaces the server's message. (3.1, 3.2)
   */
  const markDay1Complete = useCallback(async (): Promise<void> => {
    const cutValue = parseCutValue(cutValueText);
    if (cutValue === null) {
      setDay1Feedback({ kind: 'error', message: CUT_VALUE_MESSAGE });
      return;
    }
    const result = await client.completeDay1(cutValue);
    if (result.ok) {
      setDay1Feedback({
        kind: 'confirmation',
        message: `Day 1 marked complete with cut value ${cutValue}.`,
      });
    } else {
      setDay1Feedback({ kind: 'error', message: result.error });
    }
  }, [client, cutValueText]);

  /** Reverse Day 1 completion, clearing the cut value on success. (3.10) */
  const reverseDay1 = useCallback(async (): Promise<void> => {
    const result = await client.reverseDay1();
    if (result.ok) {
      setCutValueText('');
      setDay1Feedback({
        kind: 'confirmation',
        message: 'Day 1 completion reversed.',
      });
    } else {
      setDay1Feedback({ kind: 'error', message: result.error });
    }
  }, [client]);

  /**
   * Copy every player's Day 1 handicap into their Day 2 handicap, so the admin
   * only has to tweak the few that changed rather than re-enter them all. Each
   * player with a set Day 1 handicap is updated via `updatePlayer` (name and
   * Day 1 unchanged, Day 2 set to the Day 1 value). Players with no Day 1
   * handicap are skipped. On success local state adopts the returned players and
   * any stale Day 2 drafts are dropped; a summary reports how many were copied.
   */
  const copyDay1ToDay2 = useCallback(async (): Promise<void> => {
    if (copying || players === null) return;

    const toCopy = players.filter(
      (p) => p.handicapDay1 !== null && p.handicapDay1 !== p.handicapDay2,
    );
    const alreadyMatching = players.filter(
      (p) => p.handicapDay1 !== null && p.handicapDay1 === p.handicapDay2,
    ).length;

    if (toCopy.length === 0) {
      setCopyFeedback({
        kind: 'confirmation',
        message:
          alreadyMatching > 0
            ? 'Day 2 handicaps already match Day 1. Nothing to copy.'
            : 'No Day 1 handicaps set to copy.',
      });
      return;
    }

    setCopying(true);
    const outcomes = await Promise.all(
      toCopy.map(async (p) => {
        const result = await client.updatePlayer({
          id: p.id,
          name: p.name,
          handicapDay1: p.handicapDay1,
          handicapDay2: p.handicapDay1, // mirror Day 1 into Day 2
        });
        return { id: p.id, result };
      }),
    );
    setCopying(false);

    let copied = 0;
    let failed = 0;
    const updatedById = new Map<string, Player>();
    const copiedIds = new Set<string>();
    for (const { id, result } of outcomes) {
      if (result.ok) {
        copied += 1;
        updatedById.set(result.value.id, result.value);
        copiedIds.add(id);
      } else {
        failed += 1;
      }
    }

    // Adopt the updated players into local state.
    setPlayers((prev) =>
      prev ? prev.map((p) => updatedById.get(p.id) ?? p) : prev,
    );
    // Drop any in-flight Day 2 drafts for the players we just copied so the
    // fields show the newly persisted values rather than a stale edit.
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of copiedIds) delete next[fieldKey(id, 'handicapDay2')];
      return next;
    });

    const parts = [`Copied Day 1 handicaps to Day 2 for ${copied} player${copied === 1 ? '' : 's'}`];
    if (failed > 0) parts.push(`${failed} failed`);
    setCopyFeedback({
      kind: failed > 0 ? 'error' : 'confirmation',
      message: parts.join('; ') + '.',
    });
  }, [client, copying, players]);

  /**
   * Toggle a player's manual cut from Day 2 (for a player who will not return).
   * Calls the endpoint, adopts the returned player, and shows per-row feedback.
   * The override persists across Day 1 completion/reversal.
   */
  const toggleCut = useCallback(
    async (player: Player): Promise<void> => {
      const nextManualCut = !player.manualCut;
      const result = await client.setPlayerCut({
        id: player.id,
        manualCut: nextManualCut,
      });
      if (result.ok) {
        const updated = result.value;
        setPlayers((prev) =>
          prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev,
        );
        setCutFeedback((prev) => ({
          ...prev,
          [player.id]: {
            kind: 'confirmation',
            message: updated.manualCut
              ? 'Cut from Day 2.'
              : 'Reinstated for Day 2.',
          },
        }));
      } else {
        setCutFeedback((prev) => ({
          ...prev,
          [player.id]: { kind: 'error', message: result.error },
        }));
      }
    },
    [client],
  );

  /**
   * Reset the competition to a blank canvas for a new year. Guarded by a
   * type-to-confirm phrase so it cannot be triggered accidentally. On success,
   * clears local roster/state and shows a confirmation.
   */
  const resetCompetition = useCallback(async (): Promise<void> => {
    if (resetting) return;
    setResetting(true);
    const result = await client.resetCompetition(resetCourse);
    setResetting(false);
    if (result.ok) {
      // Blank canvas: clear all local roster/edit state.
      setPlayers([]);
      setDrafts({});
      setFeedback({});
      setCutFeedback({});
      setCutValueText('');
      setResetConfirmText('');
      setResetFeedback({
        kind: 'confirmation',
        message: resetCourse
          ? 'Reset complete. All players, scores, and course configuration cleared.'
          : 'Reset complete. All players and scores cleared; course kept.',
      });
    } else {
      setResetFeedback({ kind: 'error', message: result.error });
    }
  }, [client, resetting, resetCourse]);

  /**
   * Move a player one position up or down within the currently selected day's
   * order and persist the new order. Optimistically applies the reorder to local
   * state so the table reflects the move immediately, then calls the endpoint;
   * on rejection it reloads the authoritative order and shows the message.
   */
  const movePlayer = useCallback(
    async (playerId: string, direction: 'up' | 'down'): Promise<void> => {
      if (players === null) return;

      const ordered = sortByDayOrder(players, orderDay);
      const index = ordered.findIndex((p) => p.id === playerId);
      if (index === -1) return;
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= ordered.length) return;

      // Swap the two rows to form the new order.
      const reordered = [...ordered];
      const [moved] = reordered.splice(index, 1);
      if (moved === undefined) return;
      reordered.splice(target, 0, moved);
      const orderedIds = reordered.map((p) => p.id);

      // Optimistically update local order values so the row moves right away.
      const positionById = new Map(orderedIds.map((id, i) => [id, i + 1]));
      setPlayers((prev) =>
        prev
          ? prev.map((p) =>
              positionById.has(p.id)
                ? {
                    ...p,
                    orderDay1: orderDay === 1 ? positionById.get(p.id)! : p.orderDay1,
                    orderDay2: orderDay === 2 ? positionById.get(p.id)! : p.orderDay2,
                  }
                : p,
            )
          : prev,
      );
      setOrderFeedback(null);

      const result = await client.reorderPlayers({ day: orderDay, orderedIds });
      if (result.ok) {
        setPlayers(result.value);
      } else {
        // Reload the authoritative order and surface the message.
        const reload = await client.getPlayers();
        if (reload.ok) setPlayers(reload.value);
        setOrderFeedback({ kind: 'error', message: result.error });
      }
    },
    [client, players, orderDay],
  );

  // The roster rows in the currently selected day's display order.
  const playerRows = useMemo(
    () => (players ? sortByDayOrder(players, orderDay) : []),
    [players, orderDay],
  );

  return (
    <section aria-labelledby="competition-setup-heading" className="competition-setup">
      <h2 id="competition-setup-heading">Competition Setup</h2>
      <p>
        Add players and enter each player&apos;s Day 1 and Day 2 playing handicap
        (0–36). Values save when you leave a field. Use the up/down arrows to set
        the order players arrive at scorer checkpoints — Day 1 and Day 2 are
        ordered independently and this drives the Score Entry grid.
      </p>

      {loadError !== null && (
        <p role="alert" className="load-error">
          {loadError}
        </p>
      )}

      <AddPlayerForm
        name={newName}
        feedback={addFeedback}
        onChangeName={(value) => {
          setNewName(value);
          setAddFeedback(null);
        }}
        onSubmit={() => void addPlayer()}
      />

      {players === null ? (
        <p aria-live="polite">Loading players…</p>
      ) : playerRows.length === 0 ? (
        <p aria-live="polite">No players yet. Add one above.</p>
      ) : (
        <>
          <div
            className="order-day-selector"
            role="tablist"
            aria-label="Select day whose player order to edit"
          >
            <span className="order-day-label">Editing order for:</span>
            {DAYS.map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={orderDay === d}
                className={orderDay === d ? 'day-tab day-tab--active' : 'day-tab'}
                onClick={() => {
                  setOrderDay(d);
                  setOrderFeedback(null);
                }}
              >
                Day {d}
              </button>
            ))}
          </div>
          <p className="order-hint">
            Use the up/down arrows to set the Day {orderDay} order players arrive
            at scorer checkpoints. This order drives the Score Entry grid and is
            saved per day.
          </p>
          {orderFeedback && (
            <p role="alert" className="field-error">
              {orderFeedback.message}
            </p>
          )}
          <div className="copy-handicaps">
            <button
              type="button"
              onClick={() => void copyDay1ToDay2()}
              disabled={copying}
            >
              {copying ? 'Copying…' : 'Copy Day 1 handicaps to Day 2'}
            </button>
            <span className="copy-handicaps-hint">
              Fills each player&apos;s Day 2 handicap from their Day 1 value;
              adjust any that changed afterwards.
            </span>
            {copyFeedback && (
              <span
                className={
                  copyFeedback.kind === 'error'
                    ? 'field-error'
                    : 'field-confirmation'
                }
                role={copyFeedback.kind === 'error' ? 'alert' : 'status'}
              >
                {copyFeedback.message}
              </span>
            )}
          </div>
          <table className="players-table">
            <caption className="visually-hidden">
              Players with editable name and per-day handicaps, in Day {orderDay}{' '}
              order
            </caption>
            <thead>
              <tr>
                <th scope="col">Day {orderDay} order</th>
                <th scope="col">Name</th>
                <th scope="col">Day 1 handicap</th>
                <th scope="col">Day 2 handicap</th>
                <th scope="col">Day 2</th>
              </tr>
            </thead>
            <tbody>
              {playerRows.map((player, index) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  position={index + 1}
                  isFirst={index === 0}
                  isLast={index === playerRows.length - 1}
                  nameText={textFor(player, 'name')}
                  day1Text={textFor(player, 'handicapDay1')}
                  day2Text={textFor(player, 'handicapDay2')}
                  nameFeedback={feedback[fieldKey(player.id, 'name')]}
                  day1Feedback={feedback[fieldKey(player.id, 'handicapDay1')]}
                  day2Feedback={feedback[fieldKey(player.id, 'handicapDay2')]}
                  cutFeedback={cutFeedback[player.id]}
                  onChangeField={onChangeField}
                  onSaveField={saveField}
                  onMoveUp={() => void movePlayer(player.id, 'up')}
                  onMoveDown={() => void movePlayer(player.id, 'down')}
                  onToggleCut={() => void toggleCut(player)}
                />
              ))}
            </tbody>
          </table>
        </>
      )}

      <Day1CompletionPanel
        cutValueText={cutValueText}
        feedback={day1Feedback}
        onChangeCutValue={(value) => {
          setCutValueText(value);
          setDay1Feedback(null);
        }}
        onMarkComplete={() => void markDay1Complete()}
        onReverse={() => void reverseDay1()}
      />

      <section className="danger-zone" aria-labelledby="reset-heading">
        <h3 id="reset-heading">Reset for a new year</h3>
        <p>
          Once all scores are in and confirmed, reset the app to a blank canvas
          for the next competition. This permanently deletes <strong>all
          players and all scores</strong> and clears the Day 1 completion. This
          cannot be undone.
        </p>
        <label className="danger-checkbox">
          <input
            type="checkbox"
            checked={resetCourse}
            onChange={(event) => setResetCourse(event.target.checked)}
          />
          Also clear the course configuration (par and stroke index). Leave
          unchecked to keep the same course next year.
        </label>
        <div className="danger-confirm">
          <label htmlFor="reset-confirm">
            Type <strong>RESET</strong> to confirm:
          </label>
          <input
            id="reset-confirm"
            type="text"
            autoComplete="off"
            value={resetConfirmText}
            onChange={(event) => {
              setResetConfirmText(event.target.value);
              setResetFeedback(null);
            }}
          />
          <button
            type="button"
            className="danger-button"
            disabled={resetting || resetConfirmText.trim().toUpperCase() !== 'RESET'}
            onClick={() => void resetCompetition()}
          >
            {resetting ? 'Resetting…' : 'Reset everything'}
          </button>
        </div>
        {resetFeedback && (
          <span
            className={
              resetFeedback.kind === 'error'
                ? 'field-error'
                : 'field-confirmation'
            }
            role={resetFeedback.kind === 'error' ? 'alert' : 'status'}
          >
            {resetFeedback.message}
          </span>
        )}
      </section>
    </section>
  );
}

/** Props for the add-player control. */
interface AddPlayerFormProps {
  readonly name: string;
  readonly feedback: Feedback | null;
  readonly onChangeName: (value: string) => void;
  readonly onSubmit: () => void;
}

/** The add-a-player control: a name input, an Add button, and inline feedback. */
function AddPlayerForm({
  name,
  feedback,
  onChangeName,
  onSubmit,
}: AddPlayerFormProps): JSX.Element {
  const isError = feedback?.kind === 'error';
  const feedbackId = 'add-player-feedback';

  return (
    <form
      className="add-player"
      aria-labelledby="add-player-heading"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h3 id="add-player-heading">Add player</h3>
      <input
        type="text"
        aria-label="New player name"
        maxLength={PLAYER_NAME_MAX_LENGTH}
        value={name}
        aria-invalid={isError || undefined}
        aria-describedby={feedback ? feedbackId : undefined}
        onChange={(event) => onChangeName(event.target.value)}
      />
      <button type="submit">Add player</button>
      {feedback && (
        <span
          id={feedbackId}
          className={isError ? 'field-error' : 'field-confirmation'}
          role={isError ? 'alert' : 'status'}
        >
          {feedback.message}
        </span>
      )}
    </form>
  );
}

/** Props for a single editable player row. */
interface PlayerRowProps {
  readonly player: Player;
  readonly position: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly nameText: string;
  readonly day1Text: string;
  readonly day2Text: string;
  readonly nameFeedback: Feedback | undefined;
  readonly day1Feedback: Feedback | undefined;
  readonly day2Feedback: Feedback | undefined;
  readonly cutFeedback: Feedback | undefined;
  readonly onChangeField: (
    playerId: string,
    field: PlayerField,
    raw: string,
  ) => void;
  readonly onSaveField: (player: Player, field: PlayerField) => void | Promise<void>;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onToggleCut: () => void;
}

/**
 * One row of the players table: the position with up/down reorder controls for
 * the selected day, the editable name, and the two per-day handicap fields, each
 * saving on blur/Enter with its own inline feedback.
 */
function PlayerRow({
  player,
  position,
  isFirst,
  isLast,
  nameText,
  day1Text,
  day2Text,
  nameFeedback,
  day1Feedback,
  day2Feedback,
  cutFeedback,
  onChangeField,
  onSaveField,
  onMoveUp,
  onMoveDown,
  onToggleCut,
}: PlayerRowProps): JSX.Element {
  return (
    <tr className={player.cut ? 'player-row--cut' : undefined}>
      <td className="order-cell">
        <div className="order-controls">
          <span className="order-position" aria-hidden="true">
            {position}
          </span>
          <button
            type="button"
            className="order-move"
            aria-label={`Move ${player.name} up`}
            disabled={isFirst}
            onClick={onMoveUp}
          >
            ▲
          </button>
          <button
            type="button"
            className="order-move"
            aria-label={`Move ${player.name} down`}
            disabled={isLast}
            onClick={onMoveDown}
          >
            ▼
          </button>
        </div>
      </td>
      <td>
        <PlayerField
          player={player}
          field="name"
          type="text"
          value={nameText}
          feedback={nameFeedback}
          label={`Name for ${player.name}`}
          onChangeField={onChangeField}
          onSaveField={onSaveField}
        />
      </td>
      <td>
        <PlayerField
          player={player}
          field="handicapDay1"
          type="number"
          value={day1Text}
          feedback={day1Feedback}
          label={`Day 1 handicap for ${player.name}`}
          onChangeField={onChangeField}
          onSaveField={onSaveField}
        />
      </td>
      <td>
        <PlayerField
          player={player}
          field="handicapDay2"
          type="number"
          value={day2Text}
          feedback={day2Feedback}
          label={`Day 2 handicap for ${player.name}`}
          onChangeField={onChangeField}
          onSaveField={onSaveField}
        />
      </td>
      <td className="cut-cell">
        <button
          type="button"
          className={
            player.cut ? 'cut-toggle cut-toggle--cut' : 'cut-toggle'
          }
          aria-pressed={player.cut}
          aria-label={
            player.cut
              ? `Reinstate ${player.name} for Day 2`
              : `Cut ${player.name} from Day 2`
          }
          onClick={onToggleCut}
        >
          {player.cut ? 'Cut ✕' : 'Cut'}
        </button>
        {cutFeedback && (
          <span
            className={
              cutFeedback.kind === 'error'
                ? 'field-error'
                : 'field-confirmation'
            }
            role={cutFeedback.kind === 'error' ? 'alert' : 'status'}
          >
            {cutFeedback.message}
          </span>
        )}
      </td>
    </tr>
  );
}

/** Props for a single editable player field. */
interface PlayerFieldProps {
  readonly player: Player;
  readonly field: PlayerField;
  readonly type: 'text' | 'number';
  readonly value: string;
  readonly feedback: Feedback | undefined;
  readonly label: string;
  readonly onChangeField: (
    playerId: string,
    field: PlayerField,
    raw: string,
  ) => void;
  readonly onSaveField: (player: Player, field: PlayerField) => void | Promise<void>;
}

/**
 * A single editable field with inline feedback. Saves on blur and on Enter. The
 * input is described by its feedback element (via `aria-describedby`) and marked
 * invalid when the feedback is an error, so screen readers announce the
 * permitted range / conflict message.
 */
function PlayerField({
  player,
  field,
  type,
  value,
  feedback,
  label,
  onChangeField,
  onSaveField,
}: PlayerFieldProps): JSX.Element {
  const feedbackId = `${field}-feedback-${player.id}`;
  const isError = feedback?.kind === 'error';
  const numericBounds =
    type === 'number' ? { min: HANDICAP_MIN, max: HANDICAP_MAX, step: 1 } : {};

  return (
    <div className="player-field">
      <input
        type={type}
        {...(type === 'number' ? { inputMode: 'numeric' as const } : {})}
        aria-label={label}
        {...numericBounds}
        {...(type === 'text' ? { maxLength: PLAYER_NAME_MAX_LENGTH } : {})}
        value={value}
        aria-invalid={isError || undefined}
        aria-describedby={feedback ? feedbackId : undefined}
        onChange={(event) => onChangeField(player.id, field, event.target.value)}
        onBlur={() => void onSaveField(player, field)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {feedback && (
        <span
          id={feedbackId}
          className={isError ? 'field-error' : 'field-confirmation'}
          role={isError ? 'alert' : 'status'}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}

/** Props for the Day 1 completion panel. */
interface Day1CompletionPanelProps {
  readonly cutValueText: string;
  readonly feedback: Feedback | null;
  readonly onChangeCutValue: (value: string) => void;
  readonly onMarkComplete: () => void;
  readonly onReverse: () => void;
}

/**
 * The Day 1 completion / reversal panel: a cut-value entry, a mark-complete
 * button gated on a positive integer, and a reverse button. Feedback is shown
 * inline; no completion status is fetched since the API exposes none. (3.1,
 * 3.2, 3.3, 3.10)
 */
function Day1CompletionPanel({
  cutValueText,
  feedback,
  onChangeCutValue,
  onMarkComplete,
  onReverse,
}: Day1CompletionPanelProps): JSX.Element {
  const isError = feedback?.kind === 'error';
  const feedbackId = 'day1-feedback';

  return (
    <section
      className="day1-completion"
      aria-labelledby="day1-completion-heading"
    >
      <h3 id="day1-completion-heading">Day 1 completion</h3>
      <p>
        Mark Day 1 complete with a cut value (a positive integer) to evaluate the
        cut. You can reverse this if you need to make corrections.
      </p>
      <div className="day1-controls">
        <label htmlFor="cut-value-input">Cut value</label>
        <input
          id="cut-value-input"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          aria-label="Cut value"
          value={cutValueText}
          aria-invalid={isError || undefined}
          aria-describedby={feedback ? feedbackId : undefined}
          onChange={(event) => onChangeCutValue(event.target.value)}
        />
        <button type="button" onClick={onMarkComplete}>
          Mark Day 1 complete
        </button>
        <button type="button" onClick={onReverse}>
          Reverse Day 1 complete
        </button>
      </div>
      {feedback && (
        <span
          id={feedbackId}
          className={isError ? 'field-error' : 'field-confirmation'}
          role={isError ? 'alert' : 'status'}
        >
          {feedback.message}
        </span>
      )}
    </section>
  );
}
