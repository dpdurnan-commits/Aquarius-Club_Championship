/**
 * Score Entry screen — batch grid (Requirement 7, grid revision).
 *
 * The original single-cell form (one player, one hole per submit) was cumbersome
 * for the real workflow: a scorer at a checkpoint collects the scores of a whole
 * group (a 2-ball or 3-ball) across several holes at once. This screen instead
 * presents a grid mirroring the Viewing_Display — rows are players, columns are
 * the 18 holes — so the scorer can type many cells across multiple players and
 * holes and submit them together.
 *
 * Rows are shown in the administrator-defined per-day order (see Competition
 * Setup), which reflects the order players arrive at checkpoints. That order is
 * independent for Day 1 and Day 2, so switching the day re-sorts the rows.
 *
 * The screen stays purely presentational over the server-authoritative rules.
 * Every cell still goes through `POST /api/scores` (one request per changed
 * cell), so all of Requirement 7 is preserved unchanged: gross range 1..20 or NR
 * (7.3, 7.11), replacement of existing values (7.6, 7.12), the CUT-player Day 2
 * rejection (7.14), and concurrent persistence across scorers (7.10). A
 * client-side pre-check mirrors the accept rule (integer 1..20 or NR) for
 * immediate feedback, but the server remains the source of truth — notably the
 * CUT gate. Current scores are prefilled from the day's view snapshot so the
 * scorer sees and can correct what is already recorded.
 *
 * Batch submit fires the changed cells concurrently and reports a per-cell
 * outcome: accepted cells adopt the submitted value and clear; rejected cells
 * keep their entered text and show the server's message inline so the scorer can
 * fix and resubmit (7.4, 7.8, 7.14).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DAYS,
  GROSS_MAX,
  GROSS_MIN,
  HOLE_ORDINALS,
  type Day,
  type HoleOrdinal,
  type Player,
  type ScoresView,
} from '@ccs/types';

/** Players printed per A4 page. (Print score sheets feature) */
const PLAYERS_PER_PAGE = 20;

/** The two nine-hole blocks a printed sheet is split into: front and back nine. */
const NINE_BLOCKS: readonly {
  readonly label: string;
  readonly ordinals: readonly HoleOrdinal[];
}[] = [
  { label: 'Holes 1–9', ordinals: HOLE_ORDINALS.slice(0, 9) },
  { label: 'Holes 10–18', ordinals: HOLE_ORDINALS.slice(9, 18) },
];

/** Split an ordered roster into fixed-size chunks (10 players per page). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Build the ordered list of printable pages for a roster.
 *
 * The page order matches the requested workflow: every front-nine page first
 * (players 1–10, then 11–20, … for holes 1–9), then every back-nine page
 * (players 1–10, then 11–20, … for holes 10–18). Players keep the entry-grid
 * order they arrive in.
 */
function buildPrintPages(
  players: readonly Player[],
): { block: (typeof NINE_BLOCKS)[number]; players: readonly Player[] }[] {
  const playerChunks = chunk(players, PLAYERS_PER_PAGE);
  const pages: {
    block: (typeof NINE_BLOCKS)[number];
    players: readonly Player[];
  }[] = [];
  for (const block of NINE_BLOCKS) {
    for (const group of playerChunks) {
      pages.push({ block, players: group });
    }
  }
  return pages;
}
import {
  apiClient,
  CLEAR_TOKEN,
  NR_TOKEN,
  type ApiClient,
  type ScoreSubmission,
} from '../api/client.js';

/** The permitted-range message for an invalid gross entry. (7.4) */
const GROSS_RANGE_MESSAGE = `Score must be a whole number from ${GROSS_MIN} to ${GROSS_MAX}, or "${NR_TOKEN}".`;

/** Return a player's display-order value for the given day. */
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

/**
 * Parse a raw cell input into a submission, mirroring the server's accept rule.
 * Returns an integer 1..20, the `NR` token (case-insensitive), or `null` when
 * the value must be rejected (non-integer or out of range). An empty string is
 * treated as "no entry" by the caller and never reaches here as a submission.
 * (7.3, 7.11)
 */
function parseSubmission(raw: string): ScoreSubmission | null {
  const trimmed = raw.trim();
  if (trimmed.toUpperCase() === NR_TOKEN) {
    return NR_TOKEN;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < GROSS_MIN || parsed > GROSS_MAX) {
    return null;
  }
  return parsed;
}

/**
 * The text a cell should display for the currently recorded value, derived from
 * a view snapshot's hole cell: the gross for a numeric cell, "NR" for a
 * no-return, or empty when unrecorded.
 */
function recordedText(view: ScoresView, playerId: string, ordinal: HoleOrdinal): string {
  const row = view.rows.find((r) => r.playerId === playerId);
  if (!row) return '';
  const cell = row.holes[ordinal - 1];
  if (!cell) return '';
  if (cell.kind === 'numeric') return String(cell.gross);
  if (cell.kind === 'NR') return NR_TOKEN;
  return '';
}

/** Key uniquely identifying one cell of the grid. */
type CellKey = `${string}:${HoleOrdinal}`;

function cellKey(playerId: string, ordinal: HoleOrdinal): CellKey {
  return `${playerId}:${ordinal}`;
}

/** Per-cell inline error after a submit attempt (accepted cells carry none). */
interface CellError {
  readonly message: string;
}

/** Props for {@link ScoreEntryScreen}. `client` is injectable for tests. */
export interface ScoreEntryScreenProps {
  readonly client?: ApiClient;
}

/**
 * The Score Entry grid: a Day selector, a players-by-holes grid of editable
 * cells prefilled with the current scores, and a batch submit that persists all
 * changed cells and reports each cell's outcome.
 */
export function ScoreEntryScreen({
  client = apiClient,
}: ScoreEntryScreenProps = {}): JSX.Element {
  // The roster (source of truth for row order via each player's per-day order).
  const [players, setPlayers] = useState<readonly Player[] | null>(null);
  // The day's view snapshot, used to prefill and to re-baseline after a submit.
  const [view, setView] = useState<ScoresView | null>(null);
  // A load-time transport error, shown at the top of the screen.
  const [loadError, setLoadError] = useState<string | null>(null);

  // The day being scored; drives both the row order and which scores load.
  const [day, setDay] = useState<Day>(1);

  // Whether Day 1 has been completed. Gates the Day 2 print action (Day 2 score
  // sheets cannot be printed until Day 1 is complete). Read from the server on
  // load so it is authoritative, not merely optimistic.
  const [day1Complete, setDay1Complete] = useState(false);

  // Live edited text per cell. A cell is only present here once the scorer has
  // typed into it; its absence means "show the recorded value".
  const [drafts, setDrafts] = useState<Partial<Record<CellKey, string>>>({});
  // Per-cell errors from the last submit; cleared when the scorer edits a cell.
  const [cellErrors, setCellErrors] = useState<Partial<Record<CellKey, CellError>>>(
    {},
  );
  // Guards against concurrent batch submits.
  const [submitting, setSubmitting] = useState(false);
  // A summary message after a batch submit (counts of saved / rejected).
  const [summary, setSummary] = useState<string | null>(null);

  /** Load the roster and the given day's view snapshot together. */
  const load = useCallback(
    async (targetDay: Day): Promise<void> => {
      const [playersResult, viewResult, stateResult] = await Promise.all([
        client.getPlayers(),
        targetDay === 1 ? client.getDay1View() : client.getDay2View(),
        client.getCompetitionState(),
      ]);
      if (playersResult.ok) {
        setPlayers(playersResult.value);
        setLoadError(null);
      } else {
        setLoadError(playersResult.error);
      }
      if (viewResult.ok) {
        setView(viewResult.value);
      }
      if (stateResult.ok) {
        setDay1Complete(stateResult.value.day1Complete);
      }
    },
    [client],
  );

  // Initial load and reload whenever the day changes. Clears any in-flight
  // drafts/errors so the grid reflects the newly selected day cleanly.
  useEffect(() => {
    setDrafts({});
    setCellErrors({});
    setSummary(null);
    void load(day);
  }, [day, load]);

  /** Record a keystroke into a cell's draft and clear its stale error. */
  const onChangeCell = useCallback(
    (playerId: string, ordinal: HoleOrdinal, raw: string): void => {
      const key = cellKey(playerId, ordinal);
      setDrafts((prev) => ({ ...prev, [key]: raw }));
      setCellErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSummary(null);
    },
    [],
  );

  /** The text a cell currently shows: its draft if edited, else the recorded value. */
  const textFor = useCallback(
    (playerId: string, ordinal: HoleOrdinal): string => {
      const key = cellKey(playerId, ordinal);
      const draft = drafts[key];
      if (draft !== undefined) return draft;
      return view ? recordedText(view, playerId, ordinal) : '';
    },
    [drafts, view],
  );

  /**
   * The players in the row order for the selected day.
   *
   * Day 1 uses the administrator-defined checkpoint order (the up/down arrows on
   * Competition Setup). Day 2 instead orders by each player's Day 1 aggregate
   * strokes, highest first (reverse of the leaderboard), so on the final day the
   * players who scored the most on Day 1 appear at the top. The Day 1 total comes
   * from the Day 2 view snapshot (`day1AggregateStrokes`); players without a Day 1
   * total yet (no scores, or an NR) sort last, keeping the admin order among them.
   *
   * CUT players are excluded entirely from Day 2 — a cut player does not play
   * Day 2, so there is nothing to score for them. (Requirement 7.14)
   */
  const rows = useMemo(() => {
    if (!players) return [];
    if (day === 1) return sortByDayOrder(players, 1);

    // Day 2: drop cut players, then build a Day 1 aggregate-strokes lookup from
    // the Day 2 view to order the remaining players.
    const eligible = players.filter((p) => !p.cut);
    const day1StrokesById = new Map<string, number | null>();
    if (view && view.day === 2) {
      for (const row of view.rows) {
        day1StrokesById.set(row.playerId, row.day1AggregateStrokes);
      }
    }
    const adminOrder = sortByDayOrder(eligible, 2);
    return [...adminOrder].sort((a, b) => {
      const sa = day1StrokesById.get(a.id) ?? null;
      const sb = day1StrokesById.get(b.id) ?? null;
      // Players with a Day 1 total rank ahead of those without one.
      if (sa === null && sb === null) return 0; // keep admin order
      if (sa === null) return 1;
      if (sb === null) return -1;
      // Highest Day 1 strokes first (reverse score).
      return sb - sa;
    });
  }, [players, day, view]);

  /**
   * The paginated print pages for the current roster order: front-nine pages
   * (10 players each) first, then back-nine pages. Recomputed from the same
   * `rows` the grid uses, so the printed order matches the entry grid exactly.
   */
  const printPages = useMemo(() => buildPrintPages(rows), [rows]);

  /**
   * Whether printing is allowed for the selected day. Day 1 can always be
   * printed (given players exist); Day 2 is blocked until Day 1 is complete,
   * mirroring the rule that gates Day 2 scoring. (Print score sheets feature)
   */
  const canPrint = rows.length > 0 && (day === 1 || day1Complete);

  /** Open the browser print dialog for the print-only score sheets. */
  const handlePrint = useCallback((): void => {
    if (!canPrint) return;
    window.print();
  }, [canPrint]);

  /** The set of drafts that differ from the recorded value (the pending edits). */
  const pendingEdits = useMemo(() => {
    if (!view) return [];
    const edits: {
      playerId: string;
      ordinal: HoleOrdinal;
      key: CellKey;
      raw: string;
    }[] = [];
    for (const [key, raw] of Object.entries(drafts)) {
      if (raw === undefined) continue;
      // The key is `${playerId}:${ordinal}`. Split on the last colon so a
      // player id is never mis-parsed (ordinal is always the trailing segment).
      const separator = key.lastIndexOf(':');
      const playerId = key.slice(0, separator);
      const ordinal = Number(key.slice(separator + 1)) as HoleOrdinal;
      const recorded = recordedText(view, playerId, ordinal);
      // An unchanged draft (equal to what's recorded) is not a pending edit.
      if (raw.trim() === recorded) continue;
      edits.push({ playerId, ordinal, key: key as CellKey, raw });
    }
    return edits;
  }, [drafts, view]);

  /**
   * Submit every pending (changed) cell. Each is validated client-side first;
   * invalid cells get an inline range message and are not sent. A cell that was
   * emptied (blanked) but previously held a value submits a CLEAR to remove the
   * entry — the way a scorer corrects an error. Valid cells are posted
   * concurrently; accepted cells drop their draft (adopting the newly recorded
   * value), rejected cells keep their text and show the server's message.
   * Finally the day's view is reloaded so the grid shows the authoritative
   * recorded values. (7.4, 7.6, 7.8, 7.12, 7.14, score correction)
   */
  const submitBatch = useCallback(async (): Promise<void> => {
    if (submitting || !view) return;

    // Every pending edit is submittable: a non-empty cell submits its value; an
    // emptied cell (present in pendingEdits only when it previously had a
    // recorded value) submits a CLEAR to remove the stored entry.
    const submittable = pendingEdits;
    if (submittable.length === 0) {
      setSummary('No changes to submit.');
      return;
    }

    // Client-side validation pass: flag invalid cells and drop them from the
    // send. An emptied cell maps to CLEAR; otherwise the value must parse as a
    // gross 1..20 or NR.
    const valid: { edit: (typeof submittable)[number]; value: ScoreSubmission }[] = [];
    const nextErrors: Partial<Record<CellKey, CellError>> = {};
    for (const edit of submittable) {
      if (edit.raw.trim() === '') {
        valid.push({ edit, value: CLEAR_TOKEN });
        continue;
      }
      const value = parseSubmission(edit.raw);
      if (value === null) {
        nextErrors[edit.key] = { message: GROSS_RANGE_MESSAGE };
      } else {
        valid.push({ edit, value });
      }
    }

    if (valid.length === 0) {
      setCellErrors((prev) => ({ ...prev, ...nextErrors }));
      setSummary('No valid changes to submit; fix the highlighted cells.');
      return;
    }

    setSubmitting(true);
    const outcomes = await Promise.all(
      valid.map(async ({ edit, value }) => {
        const result = await client.submitScore({
          playerId: edit.playerId,
          day,
          ordinal: edit.ordinal,
          value,
        });
        return { edit, result };
      }),
    );
    setSubmitting(false);

    // Reconcile: accepted cells lose their draft; rejected cells keep it + error.
    let saved = 0;
    let rejected = 0;
    const acceptedKeys = new Set<CellKey>();
    for (const { edit, result } of outcomes) {
      if (result.ok) {
        saved += 1;
        acceptedKeys.add(edit.key);
      } else {
        rejected += 1;
        nextErrors[edit.key] = { message: result.error };
      }
    }

    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of acceptedKeys) delete next[key];
      return next;
    });
    setCellErrors((prev) => ({ ...prev, ...nextErrors }));

    // Re-baseline from the server so accepted values render as recorded.
    await load(day);

    const parts = [`${saved} saved`];
    if (rejected > 0) parts.push(`${rejected} rejected`);
    setSummary(parts.join(', ') + '.');
  }, [client, day, load, pendingEdits, submitting, view]);

  // Every pending edit counts toward the batch, including cells being cleared.
  const pendingCount = pendingEdits.length;

  return (
    <section aria-labelledby="score-entry-heading" className="score-entry">
      <h2 id="score-entry-heading">Score Entry</h2>
      <p>
        Enter gross strokes ({GROSS_MIN}–{GROSS_MAX}) or “{NR_TOKEN}” for each
        player and hole, then submit the batch. To correct a mistake, clear a
        cell (delete its contents) and submit — that removes the recorded score.
        {day === 1
          ? ' Rows follow the Day 1 order set on Competition Setup.'
          : ' Rows are ordered by Day 1 strokes, highest first.'}{' '}
        Existing scores are shown and can be edited.
      </p>

      <div
        className="day-selector"
        role="tablist"
        aria-label="Select day to score"
      >
        {DAYS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={day === d}
            className={day === d ? 'day-tab day-tab--active' : 'day-tab'}
            onClick={() => setDay(d)}
          >
            Day {d}
          </button>
        ))}
      </div>

      {loadError !== null && (
        <p role="alert" className="load-error">
          {loadError}
        </p>
      )}

      {players === null ? (
        <p aria-live="polite">Loading players…</p>
      ) : rows.length === 0 ? (
        <p aria-live="polite">
          No players yet. Add players on the Competition Setup screen first.
        </p>
      ) : (
        <>
          <div className="score-entry-actions">
            <button
              type="button"
              onClick={() => void submitBatch()}
              disabled={submitting || pendingCount === 0}
            >
              {submitting
                ? 'Submitting…'
                : pendingCount === 0
                  ? 'Submit scores'
                  : `Submit ${pendingCount} score${pendingCount === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              className="print-button"
              onClick={handlePrint}
              disabled={!canPrint}
              title={
                day === 2 && !day1Complete
                  ? 'Day 2 score sheets can only be printed once Day 1 is complete.'
                  : undefined
              }
            >
              Print score sheets
            </button>
            {day === 2 && !day1Complete && (
              <span className="print-gate-hint">
                Day 2 sheets print once Day 1 is complete.
              </span>
            )}
            {summary && (
              <span className="field-confirmation" role="status">
                {summary}
              </span>
            )}
          </div>

          <form
            className="score-entry-grid-wrap"
            onSubmit={(event) => {
              event.preventDefault();
              void submitBatch();
            }}
          >
            <table className="score-table score-entry-grid">
              <caption className="visually-hidden">
                Score entry grid for Day {day}: players by holes
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="player-name-header">
                    Player
                  </th>
                  {HOLE_ORDINALS.map((h) => (
                    <th key={h} scope="col" className="hole-col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Cut players are filtered out of the Day 2 rows entirely, so
                    every row here is an eligible, scorable player. */}
                {rows.map((player) => (
                  <tr key={player.id}>
                    <th scope="row" className="player-name">
                      {player.name}
                    </th>
                    {HOLE_ORDINALS.map((ordinal) => {
                      const key = cellKey(player.id, ordinal);
                      const error = cellErrors[key];
                      return (
                        <td key={ordinal} className="score-entry-cell">
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            aria-label={`${player.name}, hole ${ordinal}`}
                            aria-invalid={error ? true : undefined}
                            title={error?.message}
                            className={error ? 'score-input score-input--error' : 'score-input'}
                            value={textFor(player.id, ordinal)}
                            onChange={(e) =>
                              onChangeCell(player.id, ordinal, e.target.value)
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </form>

          {/*
            Print-only score sheets. Hidden on screen, shown only when printing
            (see the `@media print` rules). Ordered front-nine pages first then
            back-nine pages, 10 players per page, following the on-screen row
            order for the selected day. Each cell is a blank box for scorers to
            fill in by hand on the course.
          */}
          <div className="print-scoresheets" aria-hidden="true">
            {printPages.map((page, pageIndex) => (
              <div className="print-page" key={`${page.block.label}-${pageIndex}`}>
                <div className="print-page-header">
                  <h3>Club Championship — Day {day} Score Sheet</h3>
                  <span className="print-page-block">{page.block.label}</span>
                </div>
                <table className="print-sheet-table">
                  <thead>
                    <tr>
                      <th className="print-col-player">Player</th>
                      <th className="print-col-hcp">HCP</th>
                      {page.block.ordinals.map((ordinal) => (
                        <th key={ordinal} className="print-col-hole">
                          {ordinal}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.players.map((player) => (
                      <tr key={player.id}>
                        <td className="print-col-player">{player.name}</td>
                        <td className="print-col-hcp">
                          {(day === 1 ? player.handicapDay1 : player.handicapDay2) ??
                            ''}
                        </td>
                        {page.block.ordinals.map((ordinal) => (
                          <td key={ordinal} className="print-col-hole" />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
