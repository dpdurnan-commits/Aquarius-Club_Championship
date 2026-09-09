import { describe, it, expect, beforeEach } from 'vitest';
import {
  isErr,
  isOk,
  numericCell,
  type CellState,
  type Gross,
  type HoleOrdinal,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { ScoreEntryService } from './score-entry-service.js';

/**
 * Feature: club-championship-scoring
 * Concrete unit test — score-submit persistence timeout handling.
 *
 * Requirement 7.8: IF persistence of a submitted Gross_Strokes value does not
 * complete within 3 seconds, THEN THE Score_Entry_Module SHALL display an error
 * indicating the score was not saved and preserve the entered value so the
 * scorer can resubmit.
 *
 * These are example-based assertions (not property-based). They drive the real
 * ScoreEntryService over a freshly seeded in-memory SQLite Repository. A
 * persistence fault (a write that does not complete — a timeout/failure) is
 * injected by overriding the repository's `upsertScore` to throw. The service
 * must surface a save-failed result (code PERSISTENCE_FAILED, message indicating
 * the score was "not saved") and leave the last stored cell untouched, so the
 * scorer keeps the entered value. Once persistence works again, resubmitting the
 * same entered value succeeds and is then persisted.
 */
describe('ScoreEntryService — score-submit persistence timeout handling (Requirement 7.8)', () => {
  const PLAYER_ID = 'p1';
  const DAY = 1 as const;
  const ORDINAL = 5 as HoleOrdinal;
  const ENTERED: Gross = 4;

  let repository: Repository;
  let service: ScoreEntryService;
  /** The repository's real write, retained so we can restore it after the fault. */
  let realUpsert: Repository['upsertScore'];

  const unrecorded: CellState = { kind: 'unrecorded' };

  beforeEach(() => {
    repository = new Repository(openDatabase(':memory:'));
    repository.createPlayer({ id: PLAYER_ID, name: 'Alice' });
    service = new ScoreEntryService(repository);
    realUpsert = repository.upsertScore.bind(repository);
  });

  /**
   * Force the next `upsertScore` write to fail — a persistence timeout/failure
   * (the write "does not complete"). The service wraps the write and must
   * surface this as a save-failed result rather than throwing.
   */
  const injectPersistenceTimeout = (): void => {
    repository.upsertScore = (): void => {
      throw new Error('simulated persistence timeout');
    };
  };

  /** Restore the real write so persistence works again (as on a resubmission). */
  const restorePersistence = (): void => {
    repository.upsertScore = realUpsert;
  };

  it('returns a "score not saved" error and preserves the entered value for resubmission when persistence does not complete (Requirement 7.8)', () => {
    // Precondition: the target cell starts unrecorded.
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(unrecorded);

    injectPersistenceTimeout();

    const result = service.submitScore(PLAYER_ID, DAY, ORDINAL, ENTERED);

    // The submission is reported as a save that did not complete.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
      expect(result.error.toLowerCase()).toContain('not saved');
    }

    // The last stored cell is untouched — nothing was persisted, so the scorer
    // still holds the entered value to resubmit.
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(unrecorded);

    // Resubmission once persistence works again succeeds and persists the SAME
    // entered value the scorer preserved.
    restorePersistence();
    const resubmit = service.submitScore(PLAYER_ID, DAY, ORDINAL, ENTERED);

    expect(isOk(resubmit)).toBe(true);
    if (isOk(resubmit)) {
      expect(resubmit.value.state).toEqual(numericCell(ENTERED));
    }
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(
      numericCell(ENTERED),
    );
  });

  it('leaves a previously stored value intact when a later submission fails to persist (Requirement 7.8)', () => {
    // Seed a prior successfully stored value on the cell.
    const prior: Gross = 3;
    const seeded = service.submitScore(PLAYER_ID, DAY, ORDINAL, prior);
    expect(isOk(seeded)).toBe(true);
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(
      numericCell(prior),
    );

    // A later submission of a new value hits a persistence timeout.
    injectPersistenceTimeout();
    const result = service.submitScore(PLAYER_ID, DAY, ORDINAL, ENTERED);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
      expect(result.error.toLowerCase()).toContain('not saved');
    }

    // The last successfully stored value is retained unchanged.
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(
      numericCell(prior),
    );

    // Resubmitting the entered value once persistence recovers replaces the
    // prior value with the entered one.
    restorePersistence();
    const resubmit = service.submitScore(PLAYER_ID, DAY, ORDINAL, ENTERED);
    expect(isOk(resubmit)).toBe(true);
    expect(repository.getCellState(PLAYER_ID, DAY, ORDINAL)).toEqual(
      numericCell(ENTERED),
    );
  });
});
