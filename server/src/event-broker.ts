/**
 * EventBroker — in-process fan-out of domain events with sequence ids and a
 * bounded replay buffer for `Last-Event-ID` resync (Requirement 10).
 *
 * The broker is the single hub between the domain services and the SSE endpoint.
 * Services publish domain events after a successful persistence write; the broker
 * stamps each with a monotonically increasing sequence id, fans it out to every
 * subscriber, and retains a bounded window of the most recent events so a
 * reconnecting client can replay everything it missed via its last-seen id.
 *
 * Responsibilities (task 12.1):
 *  - Assign a monotonically increasing sequence id (starting at 1) to each
 *    published event. Callers publish the event payload WITHOUT the `id`; the
 *    broker stamps the next id and returns the fully-formed {@link DomainEvent}.
 *    Each event carries this id as the SSE event id used for replay. (10.1)
 *  - Fan out every published event to all current subscribers, so each connected
 *    display receives every subsequent update without a manual reload. (10.1,
 *    10.2, 10.3)
 *  - Retain a bounded buffer (default 1000, configurable) of the most recent
 *    events for `Last-Event-ID` replay, so a client whose connection dropped can
 *    apply the values persisted during the interruption on reconnect. (10.5)
 *
 * The broker holds no persistence and no external dependencies: it is a pure
 * in-process pub/sub with a ring of recent events. It never mutates the events it
 * stamps and hands out (each is frozen with its assigned id), so subscribers and
 * replay callers observe a consistent, immutable event stream.
 */

import type { DomainEvent } from '@ccs/types';

/**
 * A domain event as published by a service — the full {@link DomainEvent} shape
 * minus the `id`, which the broker owns and stamps. Callers describe *what*
 * happened; the broker decides *when* in the sequence it happened.
 */
export type PublishableEvent = Omit<DomainEvent, 'id'>;

/**
 * A subscriber callback invoked once per published event, in publish order, with
 * the fully-formed (id-stamped) event. Registered via {@link EventBroker.subscribe}.
 */
export type EventListener = (event: DomainEvent) => void;

/** Function returned by {@link EventBroker.subscribe} that detaches the listener. */
export type Unsubscribe = () => void;

/** Default upper bound on retained events when none is supplied. */
const DEFAULT_BUFFER_LIMIT = 1000;

/**
 * In-process event broker: assigns sequence ids, fans events out to subscribers,
 * and buffers recent events for `Last-Event-ID` replay (Requirement 10).
 */
export class EventBroker {
  /** The id that will be assigned to the next published event (starts at 1). (10.1) */
  private nextId = 1;

  /** Current subscribers; each receives every subsequently published event. */
  private readonly listeners = new Set<EventListener>();

  /**
   * Ring of the most recent published events in ascending id order, capped at
   * {@link bufferLimit}. Older events are evicted from the front once full. (10.5)
   */
  private readonly buffer: DomainEvent[] = [];

  /** Maximum number of events retained for replay. */
  private readonly bufferLimit: number;

  /**
   * @param bufferLimit Maximum number of recent events retained for replay.
   *   Defaults to {@link DEFAULT_BUFFER_LIMIT}. Must be a positive integer.
   */
  constructor(bufferLimit: number = DEFAULT_BUFFER_LIMIT) {
    if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
      throw new RangeError('EventBroker bufferLimit must be a positive integer.');
    }
    this.bufferLimit = bufferLimit;
  }

  /**
   * Stamp, buffer, and fan out an event. (Requirement 10.1, 10.2, 10.3)
   *
   * The caller supplies the event payload without an `id`; the broker assigns the
   * next monotonically increasing sequence id, appends the stamped event to the
   * bounded replay buffer (evicting the oldest event if the buffer is full), and
   * synchronously delivers it to every current subscriber in registration order.
   * The stamped event is frozen so downstream consumers cannot mutate the shared
   * stream, and the same instance is returned to the caller.
   *
   * @param event The domain event to publish, without its `id`.
   * @returns The fully-formed {@link DomainEvent} with its assigned sequence id.
   */
  publish(event: PublishableEvent): DomainEvent {
    // Stamp the next sequence id; the union is reconstructed by spreading the
    // discriminated payload over the assigned id. (10.1)
    const stamped = Object.freeze({ ...event, id: this.nextId }) as DomainEvent;
    this.nextId += 1;

    // Retain for replay, evicting the oldest event once the bound is reached. (10.5)
    this.buffer.push(stamped);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.shift();
    }

    // Fan out to every current subscriber. Iterate a snapshot so a listener that
    // unsubscribes (or subscribes) during delivery does not disturb this pass.
    for (const listener of [...this.listeners]) {
      listener(stamped);
    }

    return stamped;
  }

  /**
   * Register a subscriber that receives every subsequently published event.
   * (Requirement 10.1)
   *
   * The listener is invoked once per future {@link publish} call, in publish
   * order, with the id-stamped event. It does NOT receive events published before
   * subscribing — use {@link replayAfter} to catch up on missed events.
   *
   * @param listener The callback to invoke for each subsequent event.
   * @returns An idempotent unsubscribe function that detaches the listener.
   */
  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Return buffered events with id strictly greater than `lastEventId`, in
   * ascending id order, for `Last-Event-ID` replay. (Requirement 10.5)
   *
   * Contract:
   *  - Returns an array of every retained event whose id is `> lastEventId`, in
   *    ascending order. An empty array means the caller is already up to date
   *    (no newer events are buffered).
   *  - Returns `null` when the requested id is older than the oldest retained
   *    event — i.e. some events after `lastEventId` have already been evicted and
   *    can no longer be replayed. A `null` result signals the caller that
   *    incremental replay is impossible and a full snapshot resync is required.
   *    (A `lastEventId` of `0` — before any event — is always replayable while
   *    the buffer has not yet evicted its first event.)
   *
   * @param lastEventId The last sequence id the caller has already applied.
   * @returns The events after `lastEventId` in ascending id order, or `null` if a
   *   full resync is needed because the requested position has been evicted.
   */
  replayAfter(lastEventId: number): DomainEvent[] | null {
    // Nothing buffered yet: any position from 0 up to the current head is
    // trivially "caught up" — there is nothing to replay and nothing was lost.
    if (this.buffer.length === 0) {
      return [];
    }

    const oldestId = this.buffer[0]!.id;

    // The caller's position predates the oldest retained event, so at least one
    // event after it has been evicted and cannot be replayed. Signal full resync.
    // (lastEventId === oldestId - 1 is still replayable: the next event is present.)
    if (lastEventId < oldestId - 1) {
      return null;
    }

    return this.buffer.filter((event) => event.id > lastEventId);
  }
}
