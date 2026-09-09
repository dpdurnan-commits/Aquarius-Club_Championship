import { describe, it, expect, beforeEach } from 'vitest';
import { isErr, isOk, type Player } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import {
  CompetitionSetupService,
  type PlayerUpdate,
} from './competition-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Concrete unit test — persistence-failure handling on player updates.
 *
 * Requirement 2.4: THE Competition_Setup_Module SHALL provide entry of a Day 1
 * Playing_Handicap and a Day 2 Playing_Handicap for each Player.
 *
 * Requirement 2.10: IF persistence of a Player name or Playing_Handicap fails,
 * THEN THE Competition_Setup_Module SHALL retain the last successfully stored
 * values and display a message indicating the save did not complete.
 *
 * These are example-based assertions (not property-based). They drive the real
 * CompetitionSetupService over a freshly seeded in-memory SQLite Repository. A
 * persistence fault is injected by overriding the repository's `updatePlayerDetails`
 * write to throw; the service must surface a "save did not complete" result and
 * leave the last successfully stored values untouched (read back through the
 * same repository). The player model is also asserted to carry both per-day
 * handicap fields (`handicapDay1` and `handicapDay2`).
 */
describe('CompetitionSetupService — persistence-failure handling (Requirements 2.4, 2.10)', () => {
  let repository: Repository;
  let service: CompetitionSetupService;

  beforeEach(() => {
    repository = new Repository(openDatabase(':memory:'));
    service = new CompetitionSetupService(repository);
  });

  /** Seed a single player with both per-day handicaps set, returning the stored player. */
  const seedPlayer = (
    name: string,
    handicapDay1: number,
    handicapDay2: number,
  ): Player => {
    const created = service.addPlayer(name);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) throw new Error('failed to seed player');
    const id = created.value.id;

    const withDay1 = service.setHandicap(id, 1, handicapDay1 as never);
    expect(isOk(withDay1)).toBe(true);
    const withDay2 = service.setHandicap(id, 2, handicapDay2 as never);
    expect(isOk(withDay2)).toBe(true);

    const stored = repository.getPlayer(id);
    if (!stored) throw new Error('seeded player not found');
    return stored;
  };

  /** Force the next `updatePlayerDetails` write to fail (simulate a storage fault). */
  const injectPersistenceFault = (): void => {
    repository.updatePlayerDetails = (): void => {
      throw new Error('simulated persistence failure');
    };
  };

  it('exposes both per-day handicap fields on the stored player (Requirement 2.4)', () => {
    const stored = seedPlayer('Alice', 10, 20);

    // Both per-day handicap fields exist on the Player model and are stored
    // independently (Day 1 = 10, Day 2 = 20).
    expect(stored).toHaveProperty('handicapDay1');
    expect(stored).toHaveProperty('handicapDay2');
    expect(stored.handicapDay1).toBe(10);
    expect(stored.handicapDay2).toBe(20);
  });

  it('retains the last stored values and reports the save did not complete when persistence fails (Requirement 2.10)', () => {
    const before = seedPlayer('Bob', 5, 12);

    injectPersistenceFault();

    const update: PlayerUpdate = {
      name: 'Robert',
      handicapDay1: 8 as never,
      handicapDay2: 15 as never,
    };
    const result = service.updatePlayer(before.id, update);

    // The update is reported as a save that did not complete.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
      expect(result.error).toContain('save did not complete');
    }

    // The last successfully stored values are retained unchanged: name and both
    // per-day handicaps are exactly what they were before the failed write.
    const after = repository.getPlayer(before.id);
    expect(after).toEqual(before);
    expect(after?.name).toBe('Bob');
    expect(after?.handicapDay1).toBe(5);
    expect(after?.handicapDay2).toBe(12);
  });

  it('does not partially apply the update when persistence fails (Requirement 2.10)', () => {
    const before = seedPlayer('Carol', 0, 36);

    injectPersistenceFault();

    // Attempt to change only the name; the fault must leave everything intact.
    const result = service.updatePlayer(before.id, {
      name: 'Caroline',
      handicapDay1: before.handicapDay1,
      handicapDay2: before.handicapDay2,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
      expect(result.error).toContain('save did not complete');
    }

    // No field changed — the stored player is byte-for-byte the pre-fault value.
    expect(repository.getPlayer(before.id)).toEqual(before);
  });
});
