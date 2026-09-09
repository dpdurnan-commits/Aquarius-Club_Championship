import { describe, it, expect } from 'vitest';
import type { DomainEvent } from '@ccs/types';
import {
  EventBroker,
  type PublishableEvent,
} from './event-broker.js';

/** A representative publishable score-changed event payload (no id). */
function scoreEvent(playerId = 'p1'): PublishableEvent {
  return { type: 'score-changed', playerId, day: 1, ordinal: 1 };
}

describe('EventBroker — constructor validation', () => {
  it('accepts a positive integer bufferLimit', () => {
    expect(() => new EventBroker(1)).not.toThrow();
    expect(() => new EventBroker(1000)).not.toThrow();
  });

  it('throws RangeError for a non-positive-integer bufferLimit', () => {
    expect(() => new EventBroker(0)).toThrow(RangeError);
    expect(() => new EventBroker(-5)).toThrow(RangeError);
    expect(() => new EventBroker(2.5)).toThrow(RangeError);
    expect(() => new EventBroker(Number.NaN)).toThrow(RangeError);
  });
});

describe('EventBroker — fan-out and id stamping (Requirement 10.1)', () => {
  it('delivers each published event to every registered subscriber', () => {
    const broker = new EventBroker();
    const receivedA: DomainEvent[] = [];
    const receivedB: DomainEvent[] = [];
    const receivedC: DomainEvent[] = [];
    broker.subscribe((e) => receivedA.push(e));
    broker.subscribe((e) => receivedB.push(e));
    broker.subscribe((e) => receivedC.push(e));

    broker.publish(scoreEvent('p1'));
    broker.publish({ type: 'day1-status-changed', day1Complete: true });
    broker.publish({ type: 'course-changed', ordinal: 5 });

    // Every subscriber saw all three events.
    expect(receivedA).toHaveLength(3);
    expect(receivedB).toHaveLength(3);
    expect(receivedC).toHaveLength(3);
    // Each subscriber saw the same instances in the same order.
    expect(receivedA).toEqual(receivedB);
    expect(receivedB).toEqual(receivedC);
  });

  it('stamps monotonically increasing ids starting at 1 in publish order', () => {
    const broker = new EventBroker();
    const received: DomainEvent[] = [];
    broker.subscribe((e) => received.push(e));

    broker.publish(scoreEvent('p1'));
    broker.publish(scoreEvent('p2'));
    broker.publish(scoreEvent('p3'));

    expect(received.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('preserves the event payload alongside the stamped id', () => {
    const broker = new EventBroker();
    const received: DomainEvent[] = [];
    broker.subscribe((e) => received.push(e));

    broker.publish({ type: 'player-changed', playerId: 'p42' });

    expect(received[0]).toEqual({ type: 'player-changed', playerId: 'p42', id: 1 });
  });
});

describe('EventBroker — publish return value (Requirement 10.1)', () => {
  it('returns the stamped event with the assigned id', () => {
    const broker = new EventBroker();
    const stamped = broker.publish(scoreEvent('p1'));
    expect(stamped).toEqual({
      type: 'score-changed',
      playerId: 'p1',
      day: 1,
      ordinal: 1,
      id: 1,
    });
  });

  it('increments the id across publishes', () => {
    const broker = new EventBroker();
    const first = broker.publish(scoreEvent('p1'));
    const second = broker.publish(scoreEvent('p2'));
    const third = broker.publish(scoreEvent('p3'));
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
  });
});

describe('EventBroker — subscribe/unsubscribe timing (Requirement 10.1)', () => {
  it('a subscriber only receives events published after it subscribed', () => {
    const broker = new EventBroker();
    broker.publish(scoreEvent('before-1')); // id 1
    broker.publish(scoreEvent('before-2')); // id 2

    const received: DomainEvent[] = [];
    broker.subscribe((e) => received.push(e));

    broker.publish(scoreEvent('after-1')); // id 3
    broker.publish(scoreEvent('after-2')); // id 4

    // Did not receive the two prior events, only the two subsequent ones.
    expect(received.map((e) => e.id)).toEqual([3, 4]);
  });

  it('unsubscribe detaches the listener so it stops receiving events', () => {
    const broker = new EventBroker();
    const received: DomainEvent[] = [];
    const unsubscribe = broker.subscribe((e) => received.push(e));

    broker.publish(scoreEvent('p1')); // id 1 — delivered
    unsubscribe();
    broker.publish(scoreEvent('p2')); // id 2 — not delivered

    expect(received.map((e) => e.id)).toEqual([1]);
  });

  it('other subscribers keep receiving after one unsubscribes', () => {
    const broker = new EventBroker();
    const kept: DomainEvent[] = [];
    const dropped: DomainEvent[] = [];
    broker.subscribe((e) => kept.push(e));
    const unsubscribe = broker.subscribe((e) => dropped.push(e));

    broker.publish(scoreEvent('p1'));
    unsubscribe();
    broker.publish(scoreEvent('p2'));

    expect(kept.map((e) => e.id)).toEqual([1, 2]);
    expect(dropped.map((e) => e.id)).toEqual([1]);
  });
});

describe('EventBroker — replayAfter (Requirement 10.5)', () => {
  function seed(broker: EventBroker, count: number): void {
    for (let i = 0; i < count; i += 1) {
      broker.publish(scoreEvent(`p${i + 1}`));
    }
  }

  it('returns only events with id strictly greater than lastEventId, ascending', () => {
    const broker = new EventBroker();
    seed(broker, 5); // ids 1..5

    const replay = broker.replayAfter(2);
    expect(replay).not.toBeNull();
    expect(replay!.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('replayAfter(0) returns all buffered events', () => {
    const broker = new EventBroker();
    seed(broker, 3); // ids 1..3

    const replay = broker.replayAfter(0);
    expect(replay).not.toBeNull();
    expect(replay!.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('replayAfter of the latest id returns an empty array (caught up)', () => {
    const broker = new EventBroker();
    seed(broker, 4); // ids 1..4

    expect(broker.replayAfter(4)).toEqual([]);
  });

  it('returns an empty array when nothing has been published', () => {
    const broker = new EventBroker();
    expect(broker.replayAfter(0)).toEqual([]);
  });
});

describe('EventBroker — replay eviction (Requirement 10.5)', () => {
  function seed(broker: EventBroker, count: number): void {
    for (let i = 0; i < count; i += 1) {
      broker.publish(scoreEvent(`p${i + 1}`));
    }
  }

  it('returns null when the requested position has been evicted (full resync needed)', () => {
    const broker = new EventBroker(3); // retains only the 3 most recent
    seed(broker, 5); // publish ids 1..5 -> buffer holds 3,4,5

    // Position 1's next event (id 2) has been evicted, so replay is impossible.
    expect(broker.replayAfter(1)).toBeNull();
    // Position 0 likewise predates the retained window.
    expect(broker.replayAfter(0)).toBeNull();
  });

  it('replays retained events for a still-retained boundary position', () => {
    const broker = new EventBroker(3);
    seed(broker, 5); // buffer holds ids 3,4,5; oldest retained id is 3

    // lastEventId === oldestId - 1 (2) is the earliest still-replayable position:
    // the next event (id 3) is present.
    const replay = broker.replayAfter(2);
    expect(replay).not.toBeNull();
    expect(replay!.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('replays a subset within the retained window', () => {
    const broker = new EventBroker(3);
    seed(broker, 5); // buffer holds ids 3,4,5

    const replay = broker.replayAfter(4);
    expect(replay).not.toBeNull();
    expect(replay!.map((e) => e.id)).toEqual([5]);
  });
});
