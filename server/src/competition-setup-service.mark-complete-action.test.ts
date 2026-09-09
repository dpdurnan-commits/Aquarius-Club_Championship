import { describe, it, expect, beforeEach } from 'vitest';
import { isOk } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CompetitionSetupService } from './competition-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Concrete unit test — the mark-Day-1-complete action is present.
 *
 * Requirement 3.1: THE Competition_Setup_Module SHALL provide an action for the
 * administrator to mark Day 1 as complete.
 *
 * These are example-based assertions (not property-based). They verify only that
 * the CompetitionSetupService exposes the mark-complete action — i.e. a callable
 * `markDay1Complete` method — and that invoking it with a valid Cut_Value
 * succeeds through the real Repository (backed by a freshly seeded in-memory
 * SQLite database). Ranking, cut evaluation, and validation behaviour are
 * covered by other tests; this test's sole concern is that the action exists and
 * can be invoked.
 */
describe('CompetitionSetupService — mark-complete action presence (Requirement 3.1)', () => {
  let repository: Repository;
  let service: CompetitionSetupService;

  beforeEach(() => {
    repository = new Repository(openDatabase(':memory:'));
    service = new CompetitionSetupService(repository);
  });

  it('exposes markDay1Complete as a callable action on the service (Requirement 3.1)', () => {
    // The mark-complete action is present as a method the administrator can invoke.
    expect(typeof service.markDay1Complete).toBe('function');
  });

  it('accepts an invocation of the mark-complete action with a valid cut value (Requirement 3.1)', () => {
    // Invoking the action with a valid positive-integer Cut_Value succeeds,
    // confirming the action is wired up and available (no players are required
    // for the action itself to be provided).
    const result = service.markDay1Complete(1);

    expect(isOk(result)).toBe(true);
  });
});
