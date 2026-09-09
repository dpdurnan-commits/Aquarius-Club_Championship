import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ok,
  err,
  isOk,
  isErr,
  cellStateOf,
  numericCell,
  HOLE_ORDINALS,
  HOLES_PER_DAY,
  type Score,
} from './index.js';

describe('Result helpers', () => {
  it('constructs and narrows success results', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) {
      expect(r.value).toBe(42);
    }
  });

  it('constructs and narrows failure results with an optional code', () => {
    const r = err('bad', 'OUT_OF_RANGE');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBe('bad');
      expect(r.code).toBe('OUT_OF_RANGE');
    }
  });
});

describe('domain constants', () => {
  it('exposes exactly 18 hole ordinals keyed 1..18', () => {
    expect(HOLES_PER_DAY).toBe(18);
    expect(HOLE_ORDINALS).toHaveLength(18);
    expect([...HOLE_ORDINALS]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });
});

describe('cellStateOf', () => {
  it('maps absent rows to unrecorded', () => {
    expect(cellStateOf(undefined)).toEqual({ kind: 'unrecorded' });
    expect(cellStateOf(null)).toEqual({ kind: 'unrecorded' });
  });

  // Confirms the shared cell-state derivation is total over all persisted rows.
  it('derives a well-defined state for any persisted score row', () => {
    fc.assert(
      fc.property(
        fc.record({
          gross: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
          noReturn: fc.boolean(),
        }),
        ({ gross, noReturn }) => {
          const score: Score = {
            playerId: 'p1',
            day: 1,
            ordinal: 1,
            gross,
            noReturn,
          };
          const state = cellStateOf(score);
          if (noReturn) return state.kind === 'NR';
          if (gross === null) return state.kind === 'unrecorded';
          return state.kind === 'numeric' && state.gross === gross;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('numericCell builds the numeric variant', () => {
    expect(numericCell(4)).toEqual({ kind: 'numeric', gross: 4 });
  });
});
