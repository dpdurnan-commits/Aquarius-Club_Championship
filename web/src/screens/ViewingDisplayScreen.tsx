/**
 * Viewing_Display screen (task 18.1).
 *
 * The clubhouse display surface for Requirements 8, 9, and 10. It renders the
 * two live leaderboards — the Day 1 and Day 2 score tables — directly from the
 * server-assembled snapshots (`GET /api/view/day1`, `GET /api/view/day2`). The
 * client is *purely presentational*: every derived value (Stableford points,
 * aggregates, positions, relative-to-par, CUT/NR handling) arrives pre-formatted
 * in the snapshot, so this screen only lays out rows and cells and never does
 * scoring math.
 *
 * How it maps to the requirements:
 *
 *  - 8.1 / 9.1: the header row is rendered from the snapshot's `header`, one
 *    column per hole in ascending ordinal order, showing ordinal / par / stroke
 *    index.
 *  - 8.2 / 9.2: one row per player, showing the player's name and that day's
 *    Playing_Handicap.
 *  - 8.3: each Day 1 hole cell shows "strokes (points)" (carried as the cell's
 *    formatted `text`; empty when unrecorded, "NR" on a no-return).
 *  - 9.17: a CUT player is marked "CUT" against their name on the Day 2 table.
 *  - 10.3: live updates are driven by the SSE hook (task 15.2) — every pushed
 *    event and every reconnect re-fetches the *current* view snapshot, so the
 *    board refreshes without a manual page reload.
 *  - 10.6: the selected day (Day 1 / Day 2) is client-side state that is
 *    retained across real-time updates — a reload swaps only the snapshot for
 *    the day the viewer is already looking at.
 *
 * The connection-status indicator (10.4/10.5) is surfaced here from the hook's
 * status so an interrupted stream is visible on the display.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DAYS,
  type Day,
  type Day1View,
  type Day2View,
  type HoleCell,
} from '@ccs/types';
import { apiClient, type ApiClient } from '../api/client.js';
import { useEventStream } from '../hooks/useEventStream.js';

/** Props for {@link ViewingDisplayScreen}. Both seams are injectable for tests. */
export interface ViewingDisplayScreenProps {
  readonly client?: ApiClient;
  /** Injectable `EventSource` factory forwarded to the SSE hook (tests). */
  readonly eventSourceFactory?: (url: string) => EventSource;
}

/** Human-readable label for the live connection-status indicator. (10.4/10.5) */
const STATUS_LABEL: Record<'connecting' | 'connected' | 'disconnected', string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Reconnecting…',
};

/**
 * Render a single hole cell's display text. The snapshot already carries the
 * fully-formatted string ("gross (points)", "NR", or empty), so this is a thin
 * pass-through that just avoids rendering an empty string as literal content.
 * (Requirements 8.3, 9.6, 9.7)
 */
function holeCellText(cell: HoleCell): string {
  return cell.text;
}

/**
 * The Viewing_Display: a Day 1 / Day 2 selector, a live connection indicator,
 * and the score table for the selected day, kept fresh over the SSE stream.
 */
export function ViewingDisplayScreen({
  client = apiClient,
  eventSourceFactory,
}: ViewingDisplayScreenProps = {}): JSX.Element {
  // The selected day is client-side state retained across live updates. (10.6)
  const [day, setDay] = useState<Day>(1);

  const [day1, setDay1] = useState<Day1View | null>(null);
  const [day2, setDay2] = useState<Day2View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Track the latest requested day so an in-flight reload for a day the viewer
  // has since navigated away from cannot clobber the newer view's state.
  const dayRef = useRef<Day>(day);
  dayRef.current = day;

  /**
   * Fetch and store the snapshot for a given day. Both the initial load and
   * every SSE-driven refresh flow through here so the board is always rendered
   * from a server-assembled snapshot. (10.3)
   */
  const loadView = useCallback(
    async (which: Day): Promise<void> => {
      if (which === 1) {
        const result = await client.getDay1View();
        // Ignore a response the viewer is no longer looking at.
        if (dayRef.current !== 1) return;
        if (result.ok) {
          setDay1(result.value);
          setLoadError(null);
        } else {
          setLoadError(result.error);
        }
      } else {
        const result = await client.getDay2View();
        if (dayRef.current !== 2) return;
        if (result.ok) {
          setDay2(result.value);
          setLoadError(null);
        } else {
          setLoadError(result.error);
        }
      }
    },
    [client],
  );

  // Load the snapshot whenever the selected day changes (initial mount + each
  // day-selector toggle). The SSE hook drives subsequent live refreshes.
  useEffect(() => {
    void loadView(day);
  }, [day, loadView]);

  // Live updates: on every pushed event and on each (re)connect, re-fetch the
  // snapshot for the day currently being viewed. Reading the day through a ref
  // keeps the callbacks stable so the SSE connection is never torn down on a
  // day toggle. (10.3, 10.5, 10.6)
  const refreshCurrent = useCallback((): void => {
    void loadView(dayRef.current);
  }, [loadView]);

  const { status } = useEventStream({
    url: client.eventsUrl(),
    onEvent: refreshCurrent,
    onResync: refreshCurrent,
    // Only forward the factory when provided so the option stays truly optional
    // under `exactOptionalPropertyTypes` (the hook falls back to the real
    // `EventSource` when it is absent).
    ...(eventSourceFactory ? { eventSourceFactory } : {}),
  });

  const activeView = day === 1 ? day1 : day2;

  return (
    <section aria-labelledby="viewing-display-heading" className="viewing-display">
      <div className="viewing-display-header">
        <h2 id="viewing-display-heading">Viewing Display</h2>
        <span
          className={`connection-status connection-status--${status}`}
          role="status"
          aria-live="polite"
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div
        className="day-selector"
        role="tablist"
        aria-label="Select day to view"
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

      {activeView === null ? (
        <p aria-live="polite">Loading Day {day} scores…</p>
      ) : activeView.day === 1 ? (
        <Day1Table view={activeView} />
      ) : (
        <Day2Table view={activeView} />
      )}
    </section>
  );
}

/** Format a per-day Playing_Handicap for the player column. (8.2, 9.2) */
function formatHandicap(handicap: number | null): string {
  return handicap === null ? '—' : String(handicap);
}

/**
 * A sortable value extracted from a row: the comparable number, or null when the
 * value is not rankable (NR / unrecorded). Null values always sort to the bottom
 * regardless of the chosen direction, so incomplete players never displace
 * ranked ones at the top of the board.
 */
type SortValue = number | null;

/** The direction a column is sorted: ascending or descending. */
type SortDirection = 'asc' | 'desc';

/**
 * Active sort selection: which column key, and the direction. `key` is null when
 * no column has been clicked yet, in which case the server's default row order
 * (Day 1 by to-par; Day 2 by combined to-par) is preserved.
 */
interface SortState<K extends string> {
  readonly key: K | null;
  readonly direction: SortDirection;
}

/**
 * Reorder rows by a chosen column while keeping incomplete (null-valued) rows at
 * the bottom. A stable sort is used, so rows with equal values keep the server's
 * incoming order (which is already a sensible leaderboard/alphabetical order).
 * When no column is selected the rows are returned unchanged.
 */
function sortRows<Row, K extends string>(
  rows: readonly Row[],
  sort: SortState<K>,
  valueOf: (row: Row, key: K) => SortValue,
): readonly Row[] {
  if (sort.key === null) return rows;
  const key = sort.key;
  const factor = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valueOf(a, key);
    const vb = valueOf(b, key);
    // Null (NR / unrecorded) always sinks to the bottom.
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * factor;
  });
}

/**
 * A clickable, sortable column header. Clicking selects the column (using the
 * provided default direction) or, if already selected, toggles the direction. An
 * arrow indicates the active column and direction for sighted users, and
 * `aria-sort` exposes it to assistive tech.
 */
function SortableHeader<K extends string>({
  label,
  columnKey,
  sort,
  onSort,
  defaultDirection,
  className,
}: {
  readonly label: string;
  readonly columnKey: K;
  readonly sort: SortState<K>;
  readonly onSort: (key: K, defaultDirection: SortDirection) => void;
  readonly defaultDirection: SortDirection;
  readonly className?: string;
}): JSX.Element {
  const active = sort.key === columnKey;
  const ariaSort = active
    ? sort.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const arrow = active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th scope="col" className={className} aria-sort={ariaSort}>
      <button
        type="button"
        className="sort-header"
        onClick={() => onSort(columnKey, defaultDirection)}
      >
        {label}
        <span aria-hidden="true">{arrow}</span>
      </button>
    </th>
  );
}

/**
 * A hook returning sort state plus a click handler. Clicking a new column adopts
 * that column's default direction; clicking the active column flips direction.
 */
function useColumnSort<K extends string>(): {
  sort: SortState<K>;
  onSort: (key: K, defaultDirection: SortDirection) => void;
} {
  const [sort, setSort] = useState<SortState<K>>({ key: null, direction: 'asc' });
  const onSort = useCallback(
    (key: K, defaultDirection: SortDirection): void => {
      setSort((prev) =>
        prev.key === key
          ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: defaultDirection },
      );
    },
    [],
  );
  return { sort, onSort };
}

/**
 * The Day 1 leaderboard table: a header of hole ordinal / par / stroke index
 * (8.1), then one row per player showing name + Day 1 handicap (8.2), the 18
 * per-hole "strokes (points)" cells (8.3), and the assembled aggregate /
 * relative-to-par columns.
 */
/** The columns the Day 1 table can be sorted by. */
type Day1SortKey = 'strokes' | 'stableford' | 'topar';

function Day1Table({ view }: { view: Day1View }): JSX.Element {
  const { sort, onSort } = useColumnSort<Day1SortKey>();

  const sortedRows = sortRows(view.rows, sort, (row, key) => {
    switch (key) {
      case 'strokes':
        return row.aggregateStrokes.isNR ? null : row.aggregateStrokes.total;
      case 'stableford':
        // Stableford total is always meaningful (accumulates over numeric holes).
        return row.aggregateStableford.total;
      case 'topar':
        return row.relativeToPar.value;
    }
  });

  return (
    <table className="score-table score-table--day1">
      <caption className="visually-hidden">Day 1 scores</caption>
      <thead>
        <tr>
          <th scope="col">Player</th>
          <th scope="col">HCP</th>
          {view.header.map((cell) => (
            <th key={cell.ordinal} scope="col" className="hole-col">
              <span className="hole-ordinal">{cell.ordinal}</span>
              <span className="hole-par">Par {cell.par ?? '—'}</span>
              <span className="hole-si">SI {cell.strokeIndex ?? '—'}</span>
            </th>
          ))}
          <SortableHeader
            label="Strokes"
            columnKey="strokes"
            sort={sort}
            onSort={onSort}
            defaultDirection="asc"
          />
          <SortableHeader
            label="Stableford"
            columnKey="stableford"
            sort={sort}
            onSort={onSort}
            defaultDirection="desc"
          />
          <SortableHeader
            label="To par"
            columnKey="topar"
            sort={sort}
            onSort={onSort}
            defaultDirection="asc"
          />
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => (
          <tr key={row.playerId}>
            <th scope="row" className="player-name">
              {row.name}
            </th>
            <td className="player-hcp">{formatHandicap(row.handicap)}</td>
            {row.holes.map((cell, index) => (
              <td
                key={view.header[index]?.ordinal ?? index}
                className={`hole-cell hole-cell--${cell.kind}`}
              >
                {holeCellText(cell)}
              </td>
            ))}
            <td className="aggregate-strokes">{row.aggregateStrokes.text}</td>
            <td className="aggregate-stableford">
              {row.aggregateStableford.text}
            </td>
            <td className="relative-to-par">{row.relativeToPar.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The Day 2 leaderboard table: a header 1..18 (9.1), then one row per player in
 * the server's leaderboard order, showing name + Day 2 handicap (9.2) with
 * "CUT" marked against a cut player's name (9.17), the Day 1 aggregate column,
 * the 18 per-hole Day 2 cells, and the combined / relative-to-par columns.
 */
/** The columns the Day 2 table can be sorted by. */
type Day2SortKey = 'strokes' | 'stableford' | 'topar' | 'totalStableford';

function Day2Table({ view }: { view: Day2View }): JSX.Element {
  const { sort, onSort } = useColumnSort<Day2SortKey>();

  const sortedRows = sortRows(view.rows, sort, (row, key) => {
    switch (key) {
      case 'strokes':
        // The Day 2 "Strokes" column shows the running combined total; sort by
        // it (null when either day is NR, which sinks the row).
        return row.combinedStrokes?.combinedTotal ?? null;
      case 'stableford':
        // The Day 2 "Stableford" column shows the Day 2 points total.
        return row.combinedStableford?.day2Total ?? null;
      case 'topar':
        return row.relativeToPar.value;
      case 'totalStableford':
        return row.combinedStableford?.total36 ?? null;
    }
  });

  return (
    <table className="score-table score-table--day2">
      <caption className="visually-hidden">Day 2 scores</caption>
      <thead>
        <tr>
          <th scope="col">Player</th>
          <th scope="col">HCP</th>
          <th scope="col">Day 1</th>
          {view.header.map((cell) => (
            <th key={cell.ordinal} scope="col" className="hole-col">
              <span className="hole-ordinal">{cell.ordinal}</span>
              <span className="hole-par">Par {cell.par ?? '—'}</span>
              <span className="hole-si">SI {cell.strokeIndex ?? '—'}</span>
            </th>
          ))}
          <SortableHeader
            label="Strokes"
            columnKey="strokes"
            sort={sort}
            onSort={onSort}
            defaultDirection="asc"
          />
          <SortableHeader
            label="Stableford"
            columnKey="stableford"
            sort={sort}
            onSort={onSort}
            defaultDirection="desc"
          />
          <SortableHeader
            label="To par"
            columnKey="topar"
            sort={sort}
            onSort={onSort}
            defaultDirection="asc"
          />
          <th scope="col">Total strokes</th>
          <SortableHeader
            label="Total Stableford"
            columnKey="totalStableford"
            sort={sort}
            onSort={onSort}
            defaultDirection="desc"
          />
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => (
          <tr key={row.playerId} className={row.cut ? 'player-row--cut' : undefined}>
            <th scope="row" className="player-name">
              {row.name}
              {row.cut && <span className="cut-badge"> CUT</span>}
            </th>
            <td className="player-hcp">{formatHandicap(row.handicap)}</td>
            <td className="day1-aggregate">
              {row.day1AggregateStrokes ?? '—'}
            </td>
            {row.holes.map((cell, index) => (
              <td
                key={view.header[index]?.ordinal ?? index}
                className={`hole-cell hole-cell--${cell.kind}`}
              >
                {holeCellText(cell)}
              </td>
            ))}
            <td className="combined-strokes">
              {row.combinedStrokes?.text ?? '—'}
            </td>
            <td className="combined-stableford">
              {row.combinedStableford?.day2Total ?? '—'}
            </td>
            <td className="relative-to-par">{row.relativeToPar.text}</td>
            <td className="total-strokes">
              {row.combinedStrokes?.combinedTotalText ?? '—'}
            </td>
            <td className="total-stableford">
              {row.combinedStableford
                ? `${row.combinedStableford.total36} (${row.combinedStableford.total36Position})`
                : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
