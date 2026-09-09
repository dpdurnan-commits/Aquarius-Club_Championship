/**
 * SSE client hook (task 15.2).
 *
 * Opens an `EventSource` to the server's `/api/events` stream and exposes the
 * live connection status plus a couple of caller-provided callbacks so a
 * consumer (the Viewing_Display, task 18) can drive live updates and resync
 * without ever touching the transport itself. The hook is deliberately
 * presentation-agnostic: it owns the connection lifecycle and reports state, but
 * renders nothing — the UI decides how to surface the status indicator.
 *
 * How it maps to the requirements:
 *
 *  - Requirement 10.3 ("update without a manual page reload"): every domain
 *    event the server pushes is delivered to `onEvent`, and each reconnect
 *    triggers `onResync`, so the display refreshes purely from the stream.
 *  - Requirement 10.4 ("connection-status indicator within 10s"): the browser's
 *    `EventSource` fires `onerror` when the socket drops. We flip status to
 *    `'disconnected'` immediately on that error (well inside the 10s budget) so
 *    the UI can render the interrupted state.
 *  - Requirement 10.5 ("clear indicator + resync within 5s"): `EventSource`
 *    reconnects automatically, replaying with `Last-Event-ID` semantics handled
 *    by the browser and honored by the server. On the reopen (`onopen`) we flip
 *    status back to `'connected'` and invoke `onResync` so the consumer re-fetches
 *    the current view snapshot, applying anything missed during the outage.
 *
 * The `EventSource` is opened once per `url` and torn down on unmount (or url
 * change), so there is never more than one live connection per hook instance.
 */

import { useEffect, useRef, useState } from 'react';
import type { DomainEvent, DomainEventType } from '@ccs/types';

/**
 * The connection lifecycle the UI can render as an indicator:
 *  - `connecting`  — the initial handshake before the first successful open.
 *  - `connected`   — the stream is open and delivering events.
 *  - `disconnected`— the stream dropped; the browser is auto-reconnecting and
 *    the indicator should show the interrupted state (Requirement 10.4).
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** The domain event types the server streams, used to register listeners. */
const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = [
  'score-changed',
  'day1-status-changed',
  'course-changed',
  'player-changed',
];

/** Options for {@link useEventStream}. */
export interface UseEventStreamOptions {
  /** The SSE endpoint to connect to (e.g. `apiClient.eventsUrl()`). */
  readonly url: string;
  /**
   * Called for each domain event pushed over the stream. Lets the consumer
   * react to individual changes (Requirement 10.3). Optional — a consumer that
   * only cares about snapshot reloads can rely on {@link onResync} alone.
   */
  readonly onEvent?: (event: DomainEvent) => void;
  /**
   * Called when the stream (re)connects: once on the initial open and again
   * after every reconnection. The consumer should (re-)fetch the current view
   * snapshot here so any events missed during an outage are applied
   * (Requirement 10.5). Also useful for the initial load.
   */
  readonly onResync?: () => void;
  /**
   * A factory for the underlying `EventSource`, injectable for tests. Defaults
   * to the global `EventSource` constructor. The connection is managed entirely
   * by the hook regardless of the factory used.
   */
  readonly eventSourceFactory?: (url: string) => EventSource;
}

/** The value returned by {@link useEventStream}. */
export interface UseEventStreamResult {
  /** The current connection status, for rendering the indicator. */
  readonly status: ConnectionStatus;
}

/** The default factory: construct a real browser `EventSource`. */
function defaultEventSourceFactory(url: string): EventSource {
  return new EventSource(url);
}

/**
 * Subscribe to the server's SSE stream and track its connection status.
 *
 * Returns the live {@link ConnectionStatus}; events and reconnects are delivered
 * through the `onEvent` / `onResync` callbacks. The connection is opened on
 * mount and closed on unmount. Callbacks are read through a ref so passing fresh
 * inline functions each render does not tear down and re-open the connection —
 * only a changed `url` (or factory) does.
 */
export function useEventStream(
  options: UseEventStreamOptions,
): UseEventStreamResult {
  const { url, onEvent, onResync, eventSourceFactory } = options;

  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  // Keep the latest callbacks and factory in refs so the connection effect can
  // stay keyed only on `url` and not tear down / re-open when a consumer passes
  // fresh inline closures (or an inline factory) on each render. Only the `url`
  // identifies a distinct connection.
  const onEventRef = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  const factoryRef = useRef(eventSourceFactory);
  onEventRef.current = onEvent;
  onResyncRef.current = onResync;
  factoryRef.current = eventSourceFactory;

  useEffect(() => {
    const factory = factoryRef.current ?? defaultEventSourceFactory;
    const source = factory(url);

    // A fresh connection attempt: not yet open.
    setStatus('connecting');

    const handleOpen = (): void => {
      // Covers both the first open and every browser auto-reconnect. Clearing
      // the indicator and asking the consumer to resync satisfies 10.5.
      setStatus('connected');
      onResyncRef.current?.();
    };

    const handleError = (): void => {
      // `EventSource` reports drops via `onerror` while it retries in the
      // background. Surface the interrupted state so the UI can show it (10.4).
      setStatus('disconnected');
    };

    const handleDomainEvent = (messageEvent: MessageEvent<string>): void => {
      const parsed = parseDomainEvent(messageEvent.data);
      if (parsed !== null) {
        onEventRef.current?.(parsed);
      }
    };

    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleError);
    for (const type of DOMAIN_EVENT_TYPES) {
      source.addEventListener(type, handleDomainEvent as EventListener);
    }

    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      for (const type of DOMAIN_EVENT_TYPES) {
        source.removeEventListener(type, handleDomainEvent as EventListener);
      }
      source.close();
    };
  }, [url]);

  return { status };
}

/**
 * Parse an SSE event's `data` payload into a {@link DomainEvent}, returning
 * `null` for malformed JSON or a payload that does not carry a recognized event
 * type. Guards the consumer from ever seeing a partial/garbage event.
 */
function parseDomainEvent(data: string): DomainEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as { type?: unknown };
  if (
    typeof candidate.type !== 'string' ||
    !DOMAIN_EVENT_TYPES.includes(candidate.type as DomainEventType)
  ) {
    return null;
  }
  return parsed as DomainEvent;
}
