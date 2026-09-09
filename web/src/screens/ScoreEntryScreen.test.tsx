import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Player } from '@ccs/types';
import { ApiClient } from '../api/client.js';
import { ScoreEntryScreen } from './ScoreEntryScreen.js';

/**
 * These tests drive the Score Entry grid through a real {@link ApiClient} backed
 * by an in-memory fake server (a `fetchImpl` stub), so the wire contract is
 * exactly what the production client speaks. The fake mirrors enough of the
 * server to exercise the grid revision of Requirement 7 from the UI seam down:
 * the roster (`GET /players`) and per-day view snapshots (`GET /view/day1|day2`)
 * that prefill the grid, single-cell `POST /scores` with gross 1..20 / NR
 * validation, the cut-player Day 2 rejection, and a persistence-failure path.
 */

/** A recorded cell in the fake server, keyed by player/day/ordinal. */
type CellKey = string;
const cellKey = (playerId: string, day: number, ordinal: number): CellKey =>
  `${playerId}:${day}:${ordinal}`;

interface CellState {
  readonly kind: 'numeric' | 'NR';
  readonly gross?: number;
}

interface FakeOptions {
  /** When true, `POST /api/scores` rejects with a network failure. (7.8) */
  readonly failPersistence?: boolean;
}

function makeFakeServer(players: Player[], options: FakeOptions = {}) {
  const roster = new Map<string, Player>(players.map((p) => [p.id, p]));
  const cells = new Map<CellKey, CellState>();

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  /** Build a view snapshot for a day from the currently recorded cells. */
  const buildView = (day: number) => {
    const header = Array.from({ length: 18 }, (_, i) => ({
      ordinal: i + 1,
      par: 4,
      strokeIndex: i + 1,
    }));
    const rows = [...roster.values()].map((p) => ({
      playerId: p.id,
      name: p.name,
      handicap: null,
      cut: p.cut,
      day1AggregateStrokes: null,
      holes: header.map((h) => {
        const state = cells.get(cellKey(p.id, day, h.ordinal));
        if (!state) return { kind: 'empty', text: '' };
        if (state.kind === 'NR') return { kind: 'NR', text: 'NR' };
        return { kind: 'numeric', gross: state.gross, points: 0, text: String(state.gross) };
      }),
      aggregateStrokes: { text: '', total: 0, position: null, isNR: false },
      aggregateStableford: { text: '', total: 0, position: null, isNR: false },
      combinedStrokes: null,
      combinedStableford: null,
      relativeToPar: { text: '', value: null, isNR: false },
    }));
    return { day, header, rows };
  };

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/players') && method === 'GET') {
      return json(200, [...roster.values()]);
    }

    if (url.endsWith('/view/day1') && method === 'GET') {
      return json(200, buildView(1));
    }
    if (url.endsWith('/view/day2') && method === 'GET') {
      return json(200, buildView(2));
    }

    if (url.endsWith('/scores') && method === 'POST') {
      if (options.failPersistence) {
        // Simulate a transport/persistence failure: the client maps a thrown
        // fetch to a PERSISTENCE_FAILED error result. (7.8)
        throw new TypeError('network down');
      }
      const body = JSON.parse(init?.body as string) as {
        playerId: string;
        day: number;
        ordinal: number;
        value: number | 'NR';
      };
      const player = roster.get(body.playerId);
      if (!player) {
        return json(404, { error: 'No player found.', code: 'NOT_FOUND' });
      }
      const isNR = body.value === 'NR';
      const gross = body.value;
      if (
        !isNR &&
        (typeof gross !== 'number' ||
          !Number.isInteger(gross) ||
          gross < 1 ||
          gross > 20)
      ) {
        return json(400, {
          error: 'Score must be a whole number from 1 to 20, or "NR".',
          code: 'OUT_OF_RANGE',
        });
      }
      if (player.cut && body.day === 2) {
        return json(400, {
          error: 'This player is cut and cannot receive a Day 2 score.',
          code: 'PLAYER_CUT',
        });
      }
      const state: CellState = isNR
        ? { kind: 'NR' }
        : { kind: 'numeric', gross: body.value as number };
      cells.set(cellKey(body.playerId, body.day, body.ordinal), state);
      return json(200, {
        playerId: body.playerId,
        day: body.day,
        ordinal: body.ordinal,
        state,
      });
    }

    return json(404, { error: 'not found' });
  }) as unknown as typeof fetch;

  return { fetchImpl, cells };
}

function renderScreen(players: Player[], options?: FakeOptions) {
  const server = makeFakeServer(players, options);
  const client = new ApiClient({ fetchImpl: server.fetchImpl });
  render(<ScoreEntryScreen client={client} />);
  return server;
}

function player(
  id: string,
  name: string,
  cut = false,
  orderDay1 = 0,
  orderDay2 = 0,
): Player {
  return {
    id,
    name,
    handicapDay1: null,
    handicapDay2: null,
    cut,
    manualCut: false,
    orderDay1,
    orderDay2,
  };
}

describe('ScoreEntryScreen (grid)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a row per player and a column per hole (7.1, 7.2)', async () => {
    renderScreen([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(await screen.findByLabelText('Alice, hole 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Bob, hole 18')).toBeInTheDocument();
  });

  it('orders rows by the selected day order (Score Entry grid ordering)', async () => {
    // Bob is first on Day 1, Alice first on Day 2.
    renderScreen([
      player('p1', 'Alice', false, 2, 1),
      player('p2', 'Bob', false, 1, 2),
    ]);
    const rowHeaders = await screen.findAllByRole('rowheader');
    expect(rowHeaders[0]).toHaveTextContent('Bob');
    expect(rowHeaders[1]).toHaveTextContent('Alice');
  });

  it('submits a batch of valid cells (7.3, 7.5)', async () => {
    const server = renderScreen([player('p1', 'Alice'), player('p2', 'Bob')]);
    const aliceHole1 = await screen.findByLabelText('Alice, hole 1');
    const bobHole1 = screen.getByLabelText('Bob, hole 1');
    fireEvent.change(aliceHole1, { target: { value: '4' } });
    fireEvent.change(bobHole1, { target: { value: 'nr' } });

    fireEvent.click(screen.getByRole('button', { name: /Submit 2 scores/ }));

    await waitFor(() => {
      expect(server.cells.get(cellKey('p1', 1, 1))).toEqual({
        kind: 'numeric',
        gross: 4,
      });
    });
    expect(server.cells.get(cellKey('p2', 1, 1))).toEqual({ kind: 'NR' });
  });

  it('flags an out-of-range cell and does not persist it (7.4)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const cell = await screen.findByLabelText('Alice, hole 1');
    fireEvent.change(cell, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit 1 score/ }));

    await waitFor(() => {
      expect(cell).toHaveAttribute('aria-invalid', 'true');
    });
    expect(server.cells.size).toBe(0);
    // The entered value is retained for correction.
    expect((cell as HTMLInputElement).value).toBe('25');
  });

  it('preserves the value and flags the cell on a persistence failure (7.8)', async () => {
    const server = renderScreen([player('p1', 'Alice')], { failPersistence: true });
    const cell = await screen.findByLabelText('Alice, hole 1');
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit 1 score/ }));

    await waitFor(() => {
      expect(cell).toHaveAttribute('aria-invalid', 'true');
    });
    expect(server.cells.size).toBe(0);
    expect((cell as HTMLInputElement).value).toBe('5');
  });

  it('removes a CUT player from the Day 2 grid but keeps them on Day 1 (7.14)', async () => {
    // Alice is cut; Bob is not.
    renderScreen([player('p1', 'Alice', true), player('p2', 'Bob', false)]);

    // On Day 1 both players are present (the cut only affects Day 2 play).
    expect(await screen.findByLabelText('Alice, hole 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Bob, hole 1')).toBeInTheDocument();

    // Switch to Day 2: the cut player's row is gone, the eligible one remains.
    fireEvent.click(screen.getByRole('tab', { name: 'Day 2' }));
    expect(await screen.findByLabelText('Bob, hole 1')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByLabelText('Alice, hole 1')).not.toBeInTheDocument();
    });
  });

  it('prompts to add players when the roster is empty (7.1)', async () => {
    renderScreen([]);
    await waitFor(() => {
      expect(
        screen.getByText(/No players yet\. Add players on the Competition Setup/),
      ).toBeInTheDocument();
    });
  });
});
