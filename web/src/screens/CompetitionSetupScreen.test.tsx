import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Player } from '@ccs/types';
import { ApiClient } from '../api/client.js';
import { CompetitionSetupScreen } from './CompetitionSetupScreen.js';

/**
 * These tests drive the screen through a real {@link ApiClient} backed by an
 * in-memory fake server (a `fetchImpl` stub), mirroring the player and Day 1
 * endpoints closely enough to exercise Requirement 2 and 3 behaviors end-to-end
 * from the UI seam down to the client: name length 1..100 + uniqueness, handicap
 * 0..36, and a positive-integer cut value.
 */

/**
 * A tiny in-memory fake of the player and Day 1 endpoints. Mirrors the server's
 * rules: name length 1..100, unique names, handicap integer 0..36, cut value a
 * positive integer.
 */
function makeFakeServer(initial: Player[] = []) {
  const players = new Map<string, Player>(initial.map((p) => [p.id, p]));
  let nextId = initial.length + 1;
  let day1Complete = false;
  let cutValue: number | null = null;

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const nameTaken = (name: string, exceptId?: string): boolean =>
    [...players.values()].some(
      (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(),
    );

  const validHandicap = (h: number | null): boolean =>
    h === null || (Number.isInteger(h) && h >= 0 && h <= 36);

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/players') && method === 'GET') {
      return json(200, [...players.values()]);
    }

    if (url.endsWith('/players') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { name: string };
      const name = body.name ?? '';
      if (name.length < 1 || name.length > 100) {
        return json(400, {
          error: 'Name must be between 1 and 100 characters.',
          code: 'OUT_OF_RANGE',
        });
      }
      if (nameTaken(name)) {
        return json(400, {
          error: `The name "${name}" is already in use.`,
          code: 'DUPLICATE',
        });
      }
      const position = players.size + 1;
      const player: Player = {
        id: `p${nextId++}`,
        name,
        handicapDay1: null,
        handicapDay2: null,
        cut: false,
        manualCut: false,
        orderDay1: position,
        orderDay2: position,
      };
      players.set(player.id, player);
      return json(200, player);
    }

    if (url.endsWith('/players') && method === 'PUT') {
      const body = JSON.parse(init?.body as string) as {
        id: string;
        name: string;
        handicapDay1: number | null;
        handicapDay2: number | null;
      };
      const current = players.get(body.id);
      if (!current) {
        return json(404, { error: 'Player not found.', code: 'NOT_FOUND' });
      }
      if (body.name.length < 1 || body.name.length > 100) {
        return json(400, {
          error: 'Name must be between 1 and 100 characters.',
          code: 'OUT_OF_RANGE',
        });
      }
      if (nameTaken(body.name, body.id)) {
        return json(400, {
          error: `The name "${body.name}" is already in use.`,
          code: 'DUPLICATE',
        });
      }
      if (!validHandicap(body.handicapDay1) || !validHandicap(body.handicapDay2)) {
        return json(400, {
          error: 'Handicap must be an integer from 0 to 36.',
          code: 'OUT_OF_RANGE',
        });
      }
      const updated: Player = {
        ...current,
        name: body.name,
        handicapDay1: body.handicapDay1,
        handicapDay2: body.handicapDay2,
      };
      players.set(updated.id, updated);
      return json(200, updated);
    }

    if (url.endsWith('/day1/complete') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { cutValue: number };
      if (!Number.isInteger(body.cutValue) || body.cutValue < 1) {
        return json(400, {
          error: 'Cut value must be a positive integer.',
          code: 'INVALID',
        });
      }
      day1Complete = true;
      cutValue = body.cutValue;
      return json(200, undefined);
    }

    if (url.endsWith('/day1/complete') && method === 'DELETE') {
      day1Complete = false;
      cutValue = null;
      return json(200, undefined);
    }

    return json(404, { error: 'not found' });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    players,
    getDay1Complete: () => day1Complete,
    getCutValue: () => cutValue,
  };
}

function renderScreen(initial?: Player[]) {
  const server = makeFakeServer(initial);
  const client = new ApiClient({ fetchImpl: server.fetchImpl });
  render(<CompetitionSetupScreen client={client} />);
  return server;
}

/** Enter a value into an input and blur it to trigger the field save. */
function enterAndBlur(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function player(
  id: string,
  name: string,
  handicapDay1: number | null = null,
  handicapDay2: number | null = null,
  orderDay1 = 0,
  orderDay2 = 0,
): Player {
  return {
    id,
    name,
    handicapDay1,
    handicapDay2,
    cut: false,
    manualCut: false,
    orderDay1,
    orderDay2,
  };
}

describe('CompetitionSetupScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders existing players with editable fields (2.4)', async () => {
    renderScreen([player('p1', 'Alice', 10, 12)]);
    await waitFor(() => {
      expect(screen.getByLabelText('Name for Alice')).toBeInTheDocument();
    });
    expect(
      (screen.getByLabelText('Day 1 handicap for Alice') as HTMLInputElement).value,
    ).toBe('10');
    expect(
      (screen.getByLabelText('Day 2 handicap for Alice') as HTMLInputElement).value,
    ).toBe('12');
  });

  it('adds a valid player, who then appears in the roster (2.1)', async () => {
    const server = renderScreen();
    const nameInput = await screen.findByLabelText('New player name');
    fireEvent.change(nameInput, { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add player' }));

    await waitFor(() => {
      expect(screen.getByText('Player "Bob" added.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Name for Bob')).toBeInTheDocument();
    expect([...server.players.values()].some((p) => p.name === 'Bob')).toBe(true);
  });

  it('rejects a duplicate player name and leaves the roster unchanged (2.3)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const nameInput = await screen.findByLabelText('New player name');
    fireEvent.change(nameInput, { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add player' }));

    await waitFor(() => {
      expect(
        screen.getByText(/The name "Alice" is already in use\./),
      ).toBeInTheDocument();
    });
    expect(server.players.size).toBe(1);
  });

  it('rejects an empty player name client-side (2.2)', async () => {
    const server = renderScreen();
    const nameInput = await screen.findByLabelText('New player name');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add player' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Name must be between 1 and 100 characters\./),
      ).toBeInTheDocument();
    });
    expect(server.players.size).toBe(0);
  });

  it('rejects a too-long player name (2.2)', async () => {
    const server = renderScreen();
    const nameInput = await screen.findByLabelText('New player name');
    // The input caps length via maxLength, so post a long name directly through
    // fireEvent (which bypasses maxLength) to exercise the rejection path.
    fireEvent.change(nameInput, { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add player' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Name must be between 1 and 100 characters\./),
      ).toBeInTheDocument();
    });
    expect(server.players.size).toBe(0);
  });

  it('edits a Day 1 handicap and shows a save confirmation (2.5)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const input = await screen.findByLabelText('Day 1 handicap for Alice');

    enterAndBlur(input, '15');

    await waitFor(() => {
      expect(screen.getByText('Day 1 handicap saved.')).toBeInTheDocument();
    });
    expect(server.players.get('p1')?.handicapDay1).toBe(15);
  });

  it('rejects an out-of-range handicap and retains the prior value (2.6)', async () => {
    const server = renderScreen([player('p1', 'Alice', 10)]);
    const input = await screen.findByLabelText('Day 1 handicap for Alice');

    enterAndBlur(input, '40');

    await waitFor(() => {
      expect(
        screen.getByText(/Handicap must be an integer from 0 to 36\./),
      ).toBeInTheDocument();
    });
    expect(server.players.get('p1')?.handicapDay1).toBe(10);
    expect((input as HTMLInputElement).value).toBe('10');
  });

  it('rejects a non-integer handicap with the permitted range (2.6)', async () => {
    renderScreen([player('p1', 'Alice')]);
    const input = await screen.findByLabelText('Day 1 handicap for Alice');

    enterAndBlur(input, '12.5');

    await waitFor(() => {
      expect(
        screen.getByText(/Handicap must be an integer from 0 to 36\./),
      ).toBeInTheDocument();
    });
  });

  it('stores Day 1 and Day 2 handicaps independently (2.7)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const day1 = await screen.findByLabelText('Day 1 handicap for Alice');
    enterAndBlur(day1, '8');
    await waitFor(() => {
      expect(screen.getByText('Day 1 handicap saved.')).toBeInTheDocument();
    });

    const day2 = screen.getByLabelText('Day 2 handicap for Alice');
    enterAndBlur(day2, '20');
    await waitFor(() => {
      expect(screen.getByText('Day 2 handicap saved.')).toBeInTheDocument();
    });

    expect(server.players.get('p1')?.handicapDay1).toBe(8);
    expect(server.players.get('p1')?.handicapDay2).toBe(20);
  });

  it('marks a rejected handicap field invalid for assistive tech (2.6)', async () => {
    renderScreen([player('p1', 'Alice')]);
    const input = await screen.findByLabelText('Day 1 handicap for Alice');
    enterAndBlur(input, '99');
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('marks Day 1 complete with a valid cut value (3.1, 3.2)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const cutInput = await screen.findByLabelText('Cut value');
    fireEvent.change(cutInput, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Day 1 complete' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Day 1 marked complete with cut value 5\./),
      ).toBeInTheDocument();
    });
    expect(server.getDay1Complete()).toBe(true);
    expect(server.getCutValue()).toBe(5);
  });

  it('rejects an invalid (zero) cut value and does not complete Day 1 (3.3)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const cutInput = await screen.findByLabelText('Cut value');
    fireEvent.change(cutInput, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Day 1 complete' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Cut value must be a positive integer\./),
      ).toBeInTheDocument();
    });
    expect(server.getDay1Complete()).toBe(false);
  });

  it('reverses Day 1 completion (3.10)', async () => {
    const server = renderScreen([player('p1', 'Alice')]);
    const cutInput = await screen.findByLabelText('Cut value');
    fireEvent.change(cutInput, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Day 1 complete' }));
    await waitFor(() => {
      expect(server.getDay1Complete()).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reverse Day 1 complete' }));
    await waitFor(() => {
      expect(screen.getByText('Day 1 completion reversed.')).toBeInTheDocument();
    });
    expect(server.getDay1Complete()).toBe(false);
    expect(server.getCutValue()).toBeNull();
    expect((cutInput as HTMLInputElement).value).toBe('');
  });
});
