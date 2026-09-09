/**
 * Connection-lifecycle test suite for the SSE hook.
 *
 * Task 15.2 seeded a minimal smoke test; task 15.3 expands it into the full
 * drop/restore status-transition suite. These tests drive a `FakeEventSource`
 * through the same event sequence the browser would produce (open, error,
 * reopen) and assert the hook surfaces the states the UI renders as the
 * connection-status indicator:
 *
 *  - Requirement 10.4: on interruption the hook flips to `disconnected` so the
 *    indicator can "show" the interrupted state.
 *  - Requirement 10.5: on restoration the hook flips back to `connected`
 *    (indicator "clears") and invokes `onResync` so the current view snapshot
 *    reloads, applying anything missed during the outage.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { DomainEvent } from '@ccs/types';
import { useEventStream } from './useEventStream.js';

/** A tiny fake `EventSource` we can drive from tests. */
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

  /** Total number of listeners registered across all event types. */
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }
}

/** Render the hook wired to a fresh `FakeEventSource`, exposing both. */
function renderStream() {
  let source: FakeEventSource | undefined;
  const onEvent = vi.fn<(event: DomainEvent) => void>();
  const onResync = vi.fn();

  const view = renderHook(() =>
    useEventStream({
      url: '/api/events',
      onEvent,
      onResync,
      eventSourceFactory: (url) => {
        source = new FakeEventSource(url);
        return source as unknown as EventSource;
      },
    }),
  );

  return {
    ...view,
    onEvent,
    onResync,
    getSource: (): FakeEventSource => {
      if (source === undefined) {
        throw new Error('EventSource factory was never invoked');
      }
      return source;
    },
  };
}

/**
 * A representative domain event for delivery assertions. `id` carries the
 * caller-supplied sequence number; `ordinal` stays a fixed valid `HoleOrdinal`.
 */
function sampleEvent(id: number): DomainEvent {
  return {
    id,
    type: 'score-changed',
    playerId: 'p1',
    day: 1,
    ordinal: 1,
  };
}

/** Emit a domain event on the fake source, wrapped in act(). */
function emitDomainEvent(source: FakeEventSource, event: DomainEvent): void {
  act(() =>
    source.emit(
      event.type,
      new MessageEvent(event.type, { data: JSON.stringify(event) }),
    ),
  );
}

describe('useEventStream connection lifecycle', () => {
  it('opens against the provided url', () => {
    const { getSource } = renderStream();
    expect(getSource().url).toBe('/api/events');
  });

  it('starts in the connecting state before any open event', () => {
    const { result, onResync } = renderStream();
    expect(result.current.status).toBe('connecting');
    expect(onResync).not.toHaveBeenCalled();
  });

  it('flips to connected and resyncs on the first open (initial snapshot)', () => {
    const { result, getSource, onResync } = renderStream();

    act(() => getSource().emit('open', new Event('open')));

    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('flips to disconnected on error so the indicator shows (Req 10.4)', () => {
    const { result, getSource } = renderStream();

    act(() => getSource().emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');

    act(() => getSource().emit('error', new Event('error')));
    expect(result.current.status).toBe('disconnected');
  });

  it('clears the indicator and resyncs on reconnect (Req 10.5)', () => {
    const { result, getSource, onResync } = renderStream();
    const source = getSource();

    // Initial open: connected + first resync (initial snapshot load).
    act(() => source.emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(1);

    // Drop: indicator shows.
    act(() => source.emit('error', new Event('error')));
    expect(result.current.status).toBe('disconnected');

    // Restore: indicator clears AND the snapshot reloads (resync #2).
    act(() => source.emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('handles a repeated drop -> restore -> drop -> restore cycle', () => {
    const { result, getSource, onResync } = renderStream();
    const source = getSource();

    // Cycle 1.
    act(() => source.emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(1);

    act(() => source.emit('error', new Event('error')));
    expect(result.current.status).toBe('disconnected');

    // Cycle 2.
    act(() => source.emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(2);

    act(() => source.emit('error', new Event('error')));
    expect(result.current.status).toBe('disconnected');

    // Final restore: resync fires on every reopen.
    act(() => source.emit('open', new Event('open')));
    expect(result.current.status).toBe('connected');
    expect(onResync).toHaveBeenCalledTimes(3);
  });

  it('delivers domain events across the connection lifecycle', () => {
    const { getSource, onEvent } = renderStream();
    const source = getSource();

    act(() => source.emit('open', new Event('open')));

    const first = sampleEvent(1);
    emitDomainEvent(source, first);
    expect(onEvent).toHaveBeenNthCalledWith(1, first);

    // A drop does not prevent events buffered/redelivered after reconnect.
    act(() => source.emit('error', new Event('error')));
    act(() => source.emit('open', new Event('open')));

    const second = sampleEvent(2);
    emitDomainEvent(source, second);
    expect(onEvent).toHaveBeenNthCalledWith(2, second);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('closes the source and removes listeners on unmount', () => {
    const { getSource, onEvent, onResync, unmount } = renderStream();
    const source = getSource();

    act(() => source.emit('open', new Event('open')));
    onResync.mockClear();
    onEvent.mockClear();
    expect(source.listenerCount()).toBeGreaterThan(0);

    unmount();

    expect(source.closed).toBe(true);
    expect(source.listenerCount()).toBe(0);

    // No callbacks fire after unmount, even if stray events arrive.
    source.emit('open', new Event('open'));
    source.emit('error', new Event('error'));
    emitDomainEvent(source, sampleEvent(9));
    expect(onResync).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
