/**
 * Shared real-time event shapes broadcast by the in-process event broker and
 * streamed over SSE. Each event carries a monotonically increasing sequence id
 * used as the SSE event id for Last-Event-ID replay. (Requirement 10)
 */

import type { Day, HoleOrdinal } from './primitives.js';

/** The kinds of events the broker fans out. */
export type DomainEventType =
  | 'score-changed'
  | 'day1-status-changed'
  | 'course-changed'
  | 'player-changed';

interface BaseEvent {
  /** Monotonically increasing sequence id, used as the SSE event id. */
  readonly id: number;
  readonly type: DomainEventType;
}

export interface ScoreChangedEvent extends BaseEvent {
  readonly type: 'score-changed';
  readonly playerId: string;
  readonly day: Day;
  readonly ordinal: HoleOrdinal;
}

export interface Day1StatusChangedEvent extends BaseEvent {
  readonly type: 'day1-status-changed';
  readonly day1Complete: boolean;
}

export interface CourseChangedEvent extends BaseEvent {
  readonly type: 'course-changed';
  readonly ordinal: HoleOrdinal;
}

export interface PlayerChangedEvent extends BaseEvent {
  readonly type: 'player-changed';
  readonly playerId: string;
}

/** Discriminated union of all broker events. */
export type DomainEvent =
  | ScoreChangedEvent
  | Day1StatusChangedEvent
  | CourseChangedEvent
  | PlayerChangedEvent;
