import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Hole, HoleOrdinal } from '@ccs/types';
import { ApiClient } from '../api/client.js';
import { CourseSetupScreen } from './CourseSetupScreen.js';

/**
 * These tests drive the screen through a real {@link ApiClient} backed by an
 * in-memory fake server (a `fetchImpl` stub). That keeps the request/response
 * wire contract exactly what the production client speaks, while letting the
 * test control persistence, the completeness status, and validation outcomes —
 * so the screen's Requirement 1 behaviors are exercised end-to-end from the UI
 * seam down to the client, without a live backend.
 */

/** Build the initial 18 unset holes, as `GET /api/course/holes` would return. */
function emptyHoles(): Hole[] {
  return Array.from({ length: 18 }, (_, i) => ({
    ordinal: (i + 1) as HoleOrdinal,
    par: null,
    strokeIndex: null,
  }));
}

/**
 * A tiny in-memory fake of the course endpoints. Mirrors the server's rules
 * closely enough to exercise the screen: par 3..6, stroke index 1..18 unique
 * (returning the conflicting hole), completeness = all pars valid AND stroke
 * indices a permutation of 1..18.
 */
function makeFakeServer(initial: Hole[] = emptyHoles()) {
  const holes = new Map<number, Hole>(initial.map((h) => [h.ordinal, h]));

  const isComplete = (): boolean => {
    const all = [...holes.values()];
    const parsOk = all.every((h) => h.par !== null && h.par >= 3 && h.par <= 6);
    const sis = all.map((h) => h.strokeIndex);
    if (sis.some((s) => s === null)) return false;
    const distinct = new Set<number>(sis as number[]);
    if (distinct.size !== 18) return false;
    for (let v = 1; v <= 18; v += 1) if (!distinct.has(v)) return false;
    return parsOk;
  };

  const json = (status: number, body: unknown): Response =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/course/holes') && method === 'GET') {
      return json(200, [...holes.values()]);
    }
    if (url.endsWith('/course/status') && method === 'GET') {
      const complete = isComplete();
      return json(200, { complete, incomplete: !complete });
    }
    if (url.endsWith('/course/holes') && method === 'PUT') {
      const body = JSON.parse(init?.body as string) as {
        ordinal: number;
        par?: number;
        strokeIndex?: number;
      };
      const current = holes.get(body.ordinal)!;
      if (body.par !== undefined) {
        if (!Number.isInteger(body.par) || body.par < 3 || body.par > 6) {
          return json(400, {
            error: 'Par must be an integer from 3 to 6.',
            code: 'OUT_OF_RANGE',
          });
        }
        holes.set(body.ordinal, { ...current, par: body.par as Hole['par'] });
      }
      if (body.strokeIndex !== undefined) {
        if (
          !Number.isInteger(body.strokeIndex) ||
          body.strokeIndex < 1 ||
          body.strokeIndex > 18
        ) {
          return json(400, {
            error: 'Stroke index must be an integer from 1 to 18.',
            code: 'OUT_OF_RANGE',
          });
        }
        const conflict = [...holes.values()].find(
          (h) => h.ordinal !== body.ordinal && h.strokeIndex === body.strokeIndex,
        );
        if (conflict) {
          return json(400, {
            error: `Stroke index ${body.strokeIndex} is already assigned to hole ${conflict.ordinal}.`,
            code: 'DUPLICATE',
          });
        }
        const after = holes.get(body.ordinal)!;
        holes.set(body.ordinal, {
          ...after,
          strokeIndex: body.strokeIndex as Hole['strokeIndex'],
        });
      }
      return json(200, holes.get(body.ordinal));
    }

    return json(404, { error: 'not found' });
  }) as unknown as typeof fetch;

  return { fetchImpl, holes, isComplete };
}

function renderScreen(initial?: Hole[]) {
  const server = makeFakeServer(initial);
  const client = new ApiClient({ fetchImpl: server.fetchImpl });
  render(<CourseSetupScreen client={client} />);
  return server;
}

/** Enter a value into an input and blur it to trigger the field save. */
function enterAndBlur(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('CourseSetupScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders exactly 18 hole rows with par and stroke-index inputs (1.1)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByLabelText('Par for hole 1')).toBeInTheDocument();
    });
    for (let ordinal = 1; ordinal <= 18; ordinal += 1) {
      expect(screen.getByLabelText(`Par for hole ${ordinal}`)).toBeInTheDocument();
      expect(
        screen.getByLabelText(`Stroke index for hole ${ordinal}`),
      ).toBeInTheDocument();
    }
  });

  it('shows the incomplete-configuration indicator until the course is complete (1.9)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/incomplete/i);
    });
  });

  it('saves a valid par and shows a save confirmation (1.2, 1.6)', async () => {
    const server = renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 1');

    enterAndBlur(parInput, '4');

    await waitFor(() => {
      expect(screen.getByText('Par saved for hole 1.')).toBeInTheDocument();
    });
    expect(server.holes.get(1)?.par).toBe(4);
  });

  it('rejects an out-of-range par, retains the prior value, and shows the permitted range (1.5)', async () => {
    const server = renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 2');

    enterAndBlur(parInput, '9');

    await waitFor(() => {
      expect(
        screen.getByText(/Par must be an integer from 3 to 6\./),
      ).toBeInTheDocument();
    });
    expect(server.holes.get(2)?.par).toBeNull();
    expect((parInput as HTMLInputElement).value).toBe('');
  });

  it('rejects a non-integer par with the permitted range (1.5)', async () => {
    renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 3');

    enterAndBlur(parInput, '3.5');

    await waitFor(() => {
      expect(
        screen.getByText(/Par must be an integer from 3 to 6\./),
      ).toBeInTheDocument();
    });
  });

  it('rejects an empty par when a field is cleared after being set (1.5)', async () => {
    const server = renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 4');

    // Save a valid value first.
    enterAndBlur(parInput, '4');
    await waitFor(() => {
      expect(screen.getByText('Par saved for hole 4.')).toBeInTheDocument();
    });

    // Now clear it: empty is rejected, prior value retained.
    enterAndBlur(parInput, '');
    await waitFor(() => {
      expect(
        screen.getByText(/Par must be an integer from 3 to 6\./),
      ).toBeInTheDocument();
    });
    expect(server.holes.get(4)?.par).toBe(4);
    expect((parInput as HTMLInputElement).value).toBe('4');
  });

  it('saves a valid stroke index and confirms (1.3, 1.6)', async () => {
    const server = renderScreen();
    const siInput = await screen.findByLabelText('Stroke index for hole 1');

    enterAndBlur(siInput, '5');

    await waitFor(() => {
      expect(
        screen.getByText('Stroke index saved for hole 1.'),
      ).toBeInTheDocument();
    });
    expect(server.holes.get(1)?.strokeIndex).toBe(5);
  });

  it('rejects a duplicate stroke index, identifies the conflicting hole, and retains the prior value (1.4)', async () => {
    const seeded = emptyHoles();
    seeded[0] = { ordinal: 1 as HoleOrdinal, par: null, strokeIndex: 7 };
    const server = renderScreen(seeded);

    const siInput = await screen.findByLabelText('Stroke index for hole 2');
    enterAndBlur(siInput, '7');

    await waitFor(() => {
      expect(
        screen.getByText(/Stroke index 7 is already assigned to hole 1\./),
      ).toBeInTheDocument();
    });
    expect(server.holes.get(2)?.strokeIndex).toBeNull();
    expect((siInput as HTMLInputElement).value).toBe('');
  });

  it('reports the configuration complete once all 18 pars and stroke indices are set (1.8)', async () => {
    const complete: Hole[] = Array.from({ length: 18 }, (_, i) => ({
      ordinal: (i + 1) as HoleOrdinal,
      par: 4 as Hole['par'],
      strokeIndex: (i + 1) as Hole['strokeIndex'],
    }));
    renderScreen(complete);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/^Course configuration is complete\.$/);
    });
  });

  it('marks a rejected field invalid for assistive tech (1.4, 1.5)', async () => {
    renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 5');

    enterAndBlur(parInput, '1');

    await waitFor(() => {
      expect(parInput).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('does not issue a save when a field is left unchanged', async () => {
    const server = renderScreen();
    const parInput = await screen.findByLabelText('Par for hole 1');
    fireEvent.focus(parInput);
    fireEvent.blur(parInput);

    const putCalls = (
      server.fetchImpl as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });
});
