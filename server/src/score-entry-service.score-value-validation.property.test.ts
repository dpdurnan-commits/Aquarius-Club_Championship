import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  GROSS_MAX,
  GROSS_MIN,
  NO_RETURN,
  isErr,
  isOk,
  numericCell,
  type CellState,
  type Day,
  type HoleOrdinal,
} from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { ScoreEntryService, NR_TOKEN, type ScoreSubmission } from './score-entry-service.js';

/**
 * Feature: club-championship-scoring
 * Property 19: Score value validation is the range 1..20 or NR
 *
 * Validates: Requirements 7.3, 7.4
 *
 * For any submitted value, a score entry is accepted if and only if it is an
 * integer in [1, 20] or the token "NR"; on rejection the existing cell value
 * for that (player, day, hole) is unchanged.
 *
 * This drives the real ScoreEntryService over a fresh in-memory SQLite
 * Repository per case. Each case first seeds a known baseline cell state
 * (unrecorded / numeric / NR) for the target (player, day, ordinal), then
 * submits a candidate value spanning the whole input space:
 *  - integers in [1, 20]              -> accept-eligible
 *  - integers outside [1, 20]         -> reject
 *  - non-integer numbers              -> reject
 *  - the NR token                     -> accept-eligible
 *  - other non-numeric tokens         -> reject
 * The accept branch is verified through the same persistence path the service
 * uses (read-back via repository.getCellState). The reject branch confirms the
 * error carries the permitted 1..20 range and that the pre-existing cell value
 * is retained byte-for-byte.
 */
describe('Property 19: Score value validation is the range 1..20 or NR', () => {
  /** A fresh service over a fresh in-memory repository with one seeded player. */
  const freshStack = (): { service: ScoreEntryService; repo: Repository } => {
    const repo = new Repository(openDatabase(':memory:'));
    repo.createPlayer({ id: 'p1', name: 'Target Player' });
    return { service: new ScoreEntryService(repo), repo };
  };

  // Candidate submission spanning the whole input space. Invalid entries are
  // cast to ScoreSubmission because the service validates arbitrary runtime
  // input even though the type nominally admits only Gross | 'NR'.
  const candidateArb: fc.Arbitrary<ScoreSubmission> = fc.oneof(
    fc.integer({ min: GROSS_MIN, max: GROSS_MAX }), // in-range integers
    fc.integer({ min: -50, max: GROSS_MIN - 1 }), // below range / zero / negative
    fc.integer({ min: GROSS_MAX + 1, max: 100 }), // above range
    fc
      .double({ min: -50, max: 100, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n)), // non-integers
    fc.constant(NR_TOKEN), // the accepted NR token
    fc.constantFrom('nr', 'Nr', '', 'X', '5', 'NR ') as fc.Arbitrary<ScoreSubmission>, // rejected tokens
  );

  /** A baseline cell state to seed before each submission. */
  const baselineStateArb: fc.Arbitrary<CellState> = fc.oneof(
    fc.constant<CellState>({ kind: 'unrecorded' }),
    fc.integer({ min: GROSS_MIN, max: GROSS_MAX }).map((g) => numericCell(g)),
    fc.constant(NO_RETURN),
  );

  /** True iff `value` is an integer in [1, 20] or the NR token. */
  const isAcceptable = (value: ScoreSubmission): boolean =>
    value === NR_TOKEN ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= GROSS_MIN &&
      value <= GROSS_MAX);

  it('accepts a submission iff it is an integer in [1,20] or "NR", otherwise rejects leaving the existing cell value unchanged (Requirements 7.3, 7.4)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Day>(1, 2),
        fc.integer({ min: 1, max: 18 }).map((n) => n as HoleOrdinal),
        baselineStateArb,
        candidateArb,
        (day, ordinal, baseline, candidate) => {
          const { service, repo } = freshStack();

          // Seed the known baseline cell state for the target cell.
          repo.upsertScore('p1', day, ordinal, baseline);
          const before = repo.getCellState('p1', day, ordinal);
          expect(before).toEqual(baseline);

          const result = service.submitScore('p1', day, ordinal, candidate);

          if (isAcceptable(candidate)) {
            // Accept branch: ok, and the persisted cell reflects the submission.
            expect(isOk(result)).toBe(true);
            const expected: CellState =
              candidate === NR_TOKEN
                ? NO_RETURN
                : numericCell(candidate as number);
            expect(repo.getCellState('p1', day, ordinal)).toEqual(expected);
          } else {
            // Reject branch: OUT_OF_RANGE with a message naming the permitted
            // 1..20 range, and the pre-existing cell value is retained.
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.code).toBe('OUT_OF_RANGE');
              expect(result.error).toContain(String(GROSS_MIN));
              expect(result.error).toContain(String(GROSS_MAX));
            }
            expect(repo.getCellState('p1', day, ordinal)).toEqual(before);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
