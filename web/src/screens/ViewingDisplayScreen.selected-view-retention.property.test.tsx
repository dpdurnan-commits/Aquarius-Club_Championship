/**
 * Feature: club-championship-scoring
 * Property 32: Selected view is retained across updates
 *
 * Validates: Requirements 10.6
 *
 * For any selected view (Day 1 or Day 2) and any sequence of real-time update
 * events, the currently selected view remains unchanged: updates only refresh
 * the data of the currently selected view, never which view is displayed.
 *
 * This drives the {@link ViewingDisplayScreen} through a real {@link ApiClient}
 * over a `fetchImpl` stub returning server-assembled snapshots, plus a fake
 * `EventSource` we drive to replay an arbitrary sequence of domain events. It
 * generates an arbitrary selected view and an arbitrary event stream, then
 * asserts the selected day tab stays selected and the day-specific content
 * (Day 2's cut-only "Bob" row) remains present for a Day 2 selection.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import fc from 'fast-check';
import type { Day, Day1View, Day2View, HoleCell, DomainEvent } from '@ccs/types';
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
        // A Day 2-only marker row: "Bob" appears only on the Day 2 table, so its
        // presence proves the Day 2 view is what is being displayed.
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

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/view/day1')) return json(200, snapshots.day1);
    if (url.endsWith('/view/day2')) return json(200, snapshots.day2);
    return json(404, { error: 'not found' });
  };

  return { fetchImpl: fetchMock as unknown as typeof fetch };
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
    getSource: (): FakeEventSource | undefined => source,
  };
}

/**
 * An arbitrary sequence of real-time update events spanning every domain event
 * type the server streams, across both days. The specific payloads are
 * irrelevant to the property (they only trigger a re-fetch of the current
 * view), so we keep generators simple while still covering the full event kind
 * space.
 */
const domainEventArb: fc.Arbitrary<DomainEvent> = fc.oneof(
  fc.record({
    id: fc.integer({ min: 1, max: 100_000 }),
    type: fc.constant('score-changed' as const),
    playerId: fc.constantFrom('p1', 'p2'),
    day: fc.constantFrom(1 as Day, 2 as Day),
    ordinal: fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<never>,
  }),
  fc.record({
    id: fc.integer({ min: 1, max: 100_000 }),
    type: fc.constant('day1-status-changed' as const),
    day1Complete: fc.boolean(),
  }),
  fc.record({
    id: fc.integer({ min: 1, max: 100_000 }),
    type: fc.constant('course-changed' as const),
    ordinal: fc.integer({ min: 1, max: 18 }) as fc.Arbitrary<never>,
  }),
  fc.record({
    id: fc.integer({ min: 1, max: 100_000 }),
    type: fc.constant('player-changed' as const),
    playerId: fc.constantFrom('p1', 'p2'),
  }),
);

const eventSequenceArb = fc.array(domainEventArb, { minLength: 0, maxLength: 8 });

describe('Property 32: Selected view is retained across updates', () => {
  afterEach(() => {
    cleanup();
  });

  it('retains the selected day across any sequence of real-time update events (Requirements 10.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(1 as Day, 2 as Day),
        eventSequenceArb,
        async (selectedDay, events) => {
          const snapshots = { day1: makeDay1View(), day2: makeDay2View() };
          const { getSource } = renderScreen(snapshots);

          // Initial render loads Day 1.
          await screen.findByText('Alice');

          // Select the arbitrary target view. Day 1 is already selected on
          // mount; only toggle when the target is Day 2.
          if (selectedDay === 2) {
            fireEvent.click(screen.getByRole('tab', { name: 'Day 2' }));
            await waitFor(() => {
              expect(
                screen.getByRole('tab', { name: 'Day 2' }),
              ).toHaveAttribute('aria-selected', 'true');
            });
          }

          const selectedTabName = `Day ${selectedDay}`;
          const otherTabName = `Day ${selectedDay === 1 ? 2 : 1}`;

          // Replay the arbitrary sequence of update events. Each maps to the
          // SSE event kind the hook listens for; the screen re-fetches the
          // current view for each one.
          for (const event of events) {
            getSource()?.emit(
              event.type,
              new MessageEvent(event.type, { data: JSON.stringify(event) }),
            );
          }

          // The selected view is retained: the same tab stays selected and the
          // other tab stays unselected, regardless of the events replayed.
          await waitFor(() => {
            expect(
              screen.getByRole('tab', { name: selectedTabName }),
            ).toHaveAttribute('aria-selected', 'true');
          });
          expect(
            screen.getByRole('tab', { name: otherTabName }),
          ).toHaveAttribute('aria-selected', 'false');

          // The displayed content is the selected view's own data: "Bob" is a
          // Day 2-only row, so it must be present iff Day 2 is selected.
          if (selectedDay === 2) {
            expect(screen.getByText('Bob')).toBeInTheDocument();
          } else {
            expect(screen.queryByText('Bob')).not.toBeInTheDocument();
          }

          cleanup();
        },
      ),
      { numRuns: 100 },
    );
    // 100 iterations, each mounting the screen and driving async fetches,
    // comfortably exceeds Vitest's 5s default; give the property room to run.
  }, 60_000);
});
