/**
 * Tests for the Viewing_Display screen (task 18.1).
 *
 * These drive the screen through a real {@link ApiClient} over a `fetchImpl`
 * stub returning server-assembled snapshots, plus a fake `EventSource` we can
 * drive to simulate the SSE stream. Together they exercise Requirements 8, 9,
 * and 10 from the display seam down:
 *  - the Day 1 / Day 2 header rows, player rows, and "strokes (points)" cells,
 *  - the "CUT" marker on the Day 2 table,
 *  - live updates without a manual reload (a pushed event re-fetches the view),
 *  - and the day selector being retained across a live update.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { Day1View, Day2View, HoleCell } from '@ccs/types';
import { ApiClient } from '../api/client.js';
import { ViewingDisplayScreen } from './ViewingDisplayScreen.js';

/** A minimal 18-column header with a couple of populated par/SI cells. */
function makeHeader() {
  return Array.from({ length: 18 }, (_, i) => ({
    ordinal: (i + 1) as never,
    par: (i === 0 ? 4 : null) as never,
    strokeIndex: (i === 0 ? 5 : null) as never,
  }));
}

function numericCell(gross: number, points: number): HoleCell {
  return { kind: 'numeric', gross, points, text: `${gross} (${points})` };
}

const emptyCell: HoleCell = { kind: 'empty', text: '' };

function holes(first?: HoleCell): readonly HoleCell[] {
  return Array.from({ length: 18 }, (_, i) =>
    i === 0 && first ? first : emptyCell,
  );
}

function makeDay1View(): Day1View {
  return {
    day: 1,
    header: makeHeader(),
    rows: [
      {
        playerId: 'p1',
        name: 'Alice',
        handicap: 12,
        holes: holes(numericCell(4, 2)),
        aggregateStrokes: { text: '4 (1)', total: 4, position: 1, isNR: false },
        aggregateStableford: { text: '2 (1)', total: 2, position: 1, isNR: false },
        relativeToPar: { text: '0', value: 0, isNR: false },
      },
    ],
  };
}

function makeDay2View(): Day2View {
  return {
    day: 2,
    header: makeHeader(),
    rows: [
      {
        playerId: 'p1',
        name: 'Alice',
        handicap: 10,
        cut: false,
        day1AggregateStrokes: 84,
        holes: holes(numericCell(5, 1)),
        combinedStrokes: {
          text: '84 (5)',
          day1Total: 84,
          day2Total: 5,
          day1IsNR: false,
          day2IsNR: false,
          combinedTotal: 89,
          combinedTotalText: '89',
        },
        combinedStableford: { text: '2 (1)', total36: 2, day2Total: 1, total36Position: 1 },
        relativeToPar: { text: '+1', value: 1, isNR: false },
      },
      {
        playerId: 'p2',
        name: 'Bob',
        handicap: 8,
        cut: true,
        day1AggregateStrokes: 110,
        holes: holes(),
        combinedStrokes: null,
        combinedStableford: null,
        relativeToPar: { text: 'NR', value: null, isNR: true },
      },
    ],
  };
}

/** A tiny fake `EventSource` the test can drive to emit stream events. */
class FakeEventSource {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface Snapshots {
  day1: Day1View;
  day2: Day2View;
}

function makeFakeServer(snapshots: Snapshots) {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/view/day1')) return json(200, snapshots.day1);
    if (url.endsWith('/view/day2')) return json(200, snapshots.day2);
    return json(404, { error: 'not found' });
  });

  return { fetchMock, fetchImpl: fetchMock as unknown as typeof fetch };
}

function renderScreen(snapshots: Snapshots) {
  const server = makeFakeServer(snapshots);
  const client = new ApiClient({ fetchImpl: server.fetchImpl });
  let source: FakeEventSource | undefined;
  render(
    <ViewingDisplayScreen
      client={client}
      eventSourceFactory={(url) => {
        source = new FakeEventSource(url);
        return source as unknown as EventSource;
      }}
    />,
  );
  return {
    fetchMock: server.fetchMock,
    getSource: (): FakeEventSource | undefined => source,
  };
}

describe('ViewingDisplayScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Day 1 header row with ordinal, par and stroke index (8.1)', async () => {
    renderScreen({ day1: makeDay1View(), day2: makeDay2View() });
    const table = await screen.findByRole('table');
    const head = within(table).getAllByRole('columnheader');
    // Player, HCP, 18 holes, Strokes, Stableford, To par.
    expect(head.length).toBe(23);
    expect(within(table).getByText('Par 4')).toBeInTheDocument();
    expect(within(table).getByText('SI 5')).toBeInTheDocument();
  });

  it('renders one Day 1 row per player with name and handicap (8.2)', async () => {
    renderScreen({ day1: makeDay1View(), day2: makeDay2View() });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Day 1 handicap is 12.
    const row = screen.getByText('Alice').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('12')).toBeInTheDocument();
  });

  it('renders a Day 1 hole cell as "strokes (points)" (8.3)', async () => {
    renderScreen({ day1: makeDay1View(), day2: makeDay2View() });
    expect(await screen.findByText('4 (2)')).toBeInTheDocument();
  });

  it('switches to Day 2 and marks a CUT player against their name (9.1, 9.2, 9.17)', async () => {
    renderScreen({ day1: makeDay1View(), day2: makeDay2View() });
    await screen.findByText('Alice');

    fireEvent.click(screen.getByRole('tab', { name: 'Day 2' }));

    // Day 2 handicap for Alice is 10.
    await waitFor(() => {
      const aliceRow = screen.getByText('Alice').closest('tr');
      expect(within(aliceRow as HTMLElement).getByText('10')).toBeInTheDocument();
    });

    const bobRow = screen.getByText('Bob').closest('tr');
    expect(within(bobRow as HTMLElement).getByText('CUT')).toBeInTheDocument();
  });

  it('reloads the current view on a pushed event without a manual reload (10.3)', async () => {
    const snapshots = { day1: makeDay1View(), day2: makeDay2View() };
    const { getSource, fetchMock } = renderScreen(snapshots);

    await screen.findByText('4 (2)');

    // A new server-assembled snapshot arrives on the next fetch.
    snapshots.day1 = {
      ...snapshots.day1,
      rows: [
        {
          ...snapshots.day1.rows[0]!,
          holes: holes(numericCell(6, 0)),
        },
      ],
    };

    const before = fetchMock.mock.calls.length;
    getSource()?.emit(
      'score-changed',
      new MessageEvent('score-changed', {
        data: JSON.stringify({ id: 1, type: 'score-changed', playerId: 'p1', day: 1, ordinal: 1 }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('6 (0)')).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('retains the selected day across a live update (10.6)', async () => {
    const snapshots = { day1: makeDay1View(), day2: makeDay2View() };
    const { getSource } = renderScreen(snapshots);
    await screen.findByText('Alice');

    // Viewer selects Day 2.
    fireEvent.click(screen.getByRole('tab', { name: 'Day 2' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Day 2' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    // A live update arrives; the day selection must be retained (still Day 2).
    getSource()?.emit(
      'score-changed',
      new MessageEvent('score-changed', {
        data: JSON.stringify({ id: 2, type: 'score-changed', playerId: 'p1', day: 2, ordinal: 1 }),
      }),
    );

    await waitFor(() => {
      // Bob (a Day 2-only row) is still shown, proving we stayed on Day 2.
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'Day 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
