import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  rankScratch,
  rankStableford,
  evaluateCut,
  type PositionsByPlayer,
  type RankablePlayer,
} from './ranking-and-cut-service.js';

/**
 * Feature: club-championship-scoring
 * Property 13: Standard competition ranking with ties
 *
 * Validates: Requirements 6.1, 6.2
 *
 * For any set of ranked player values and either ordering (Day 1 gross
 * ascending for Scratch, Day 1 Stableford descending for Stableford),
 * positions use standard competition ranking: equal values share the same
 * position and the next distinct value's position skips by the size of the
 * preceding tie group (e.g. 1, 2, 2, 4), and the best value receives position 1.
 */
describe('Property 13: Standard competition ranking with ties', () => {
  // A ranked player has a numeric value and no Day 1 No_Return. NR players are
  // excluded from ranking by the service, so this property (which asserts on
  // concrete positions) is exercised over ranked (non-NR) players only.
  //
  // Values are drawn from a deliberately small range so ties occur frequently,
  // giving the tie-group-skip behaviour meaningful coverage.
  const rankablePlayerArb = (index: number): fc.Arbitrary<RankablePlayer> =>
    fc.integer({ min: 0, max: 5 }).map((value) => ({
      playerId: `p${index}`,
      value,
      hasNRDay1: false,
    }));

  // A set of ranked players with unique ids. We build ids from the array index
  // so every player id is distinct regardless of how many are generated.
  const playersArb: fc.Arbitrary<RankablePlayer[]> = fc
    .integer({ min: 1, max: 12 })
    .chain((count) =>
      fc.tuple(
        ...Array.from({ length: count }, (_unused, i) => rankablePlayerArb(i)),
      ),
    );

  // Assert standard-competition-ranking invariants against the ranked players
  // sorted into the given order (best value first). This is an independent
  // oracle: it does not reuse the service's internal ranking logic.
  function assertStandardRanking(
    players: readonly RankablePlayer[],
    positions: PositionsByPlayer,
    order: 'asc' | 'desc',
  ): void {
    // Every player gets a position (none are NR in this generator).
    for (const player of players) {
      expect(positions.get(player.playerId)).not.toBeNull();
      expect(positions.get(player.playerId)).toBeTypeOf('number');
    }

    const sorted = [...players].sort((a, b) =>
      order === 'asc' ? a.value - b.value : b.value - a.value,
    );

    // (a) The best value receives position 1.
    expect(positions.get(sorted[0]!.playerId)).toBe(1);

    // Walk the sorted list applying standard competition ranking, comparing the
    // expected position at each index with the service's output.
    let expectedPosition = 1;
    for (let i = 0; i < sorted.length; i += 1) {
      if (i > 0 && sorted[i]!.value !== sorted[i - 1]!.value) {
        // Next distinct value's position skips by the size of the preceding
        // tie group: the rank is simply the 1-based index of this element.
        expectedPosition = i + 1;
      }
      const actual = positions.get(sorted[i]!.playerId);

      // (b) Tied players share the same position; (c) distinct values skip.
      expect(actual).toBe(expectedPosition);

      // Equal values must share a position.
      if (i > 0 && sorted[i]!.value === sorted[i - 1]!.value) {
        expect(positions.get(sorted[i]!.playerId)).toBe(
          positions.get(sorted[i - 1]!.playerId),
        );
      }
    }
  }

  it('rankScratch ranks by value ascending with standard competition ranking (Requirement 6.1)', () => {
    fc.assert(
      fc.property(playersArb, (players) => {
        const positions = rankScratch(players);
        assertStandardRanking(players, positions, 'asc');
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('rankStableford ranks by value descending with standard competition ranking (Requirement 6.2)', () => {
    fc.assert(
      fc.property(playersArb, (players) => {
        const positions = rankStableford(players);
        assertStandardRanking(players, positions, 'desc');
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 14: NR players are unranked in both competitions
 *
 * Validates: Requirements 6.3
 *
 * For any roster, every player with a No_Return status on Day 1 is excluded
 * from both rankings and has no Competition_Position in either competition (a
 * `null` position), while every non-NR player receives a non-null position in
 * both the Scratch Strokeplay and Stableford competitions.
 */
describe('Property 14: NR players are unranked in both competitions', () => {
  // A player with an id, a value, and an NR flag. Values are drawn from a small
  // range so ranked players include ties, and the NR flag is generated freely
  // so rosters contain a mix of NR and non-NR players.
  const rankablePlayerArb = (index: number): fc.Arbitrary<RankablePlayer> =>
    fc.record({
      value: fc.integer({ min: 0, max: 5 }),
      hasNRDay1: fc.boolean(),
    }).map(({ value, hasNRDay1 }) => ({
      playerId: `p${index}`,
      value,
      hasNRDay1,
    }));

  // A roster with unique ids. Ids are built from the array index so every
  // player id is distinct regardless of how many players are generated.
  const rosterArb: fc.Arbitrary<RankablePlayer[]> = fc
    .integer({ min: 1, max: 12 })
    .chain((count) =>
      fc.tuple(
        ...Array.from({ length: count }, (_unused, i) => rankablePlayerArb(i)),
      ),
    );

  // Assert the NR-exclusion invariant for a single competition's positions:
  // NR players have a null position, non-NR players have a non-null position.
  function assertNRExcluded(
    players: readonly RankablePlayer[],
    positions: PositionsByPlayer,
  ): void {
    for (const player of players) {
      if (player.hasNRDay1) {
        expect(positions.get(player.playerId)).toBeNull();
      } else {
        expect(positions.get(player.playerId)).not.toBeNull();
        expect(positions.get(player.playerId)).toBeTypeOf('number');
      }
    }
  }

  it('NR players get a null position and non-NR players a non-null position in both competitions (Requirement 6.3)', () => {
    fc.assert(
      fc.property(rosterArb, (players) => {
        assertNRExcluded(players, rankScratch(players));
        assertNRExcluded(players, rankStableford(players));
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: club-championship-scoring
 * Property 15: Cut decision correctness
 *
 * Validates: Requirements 3.4, 3.5, 3.6, 3.7
 *
 * For any roster, scores, and valid positive cut value X, after Day 1 is marked
 * complete each player is CUT if and only if the player has a Day 1 NR (3.5), or
 * the player has a position greater than X in both competitions (3.6);
 * equivalently a player advances (not cut) exactly when the player has no Day 1
 * NR and has a position <= X in at least one competition (3.7). Every player in
 * the roster receives a cut decision (3.4).
 */
describe('Property 15: Cut decision correctness', () => {
  // A player with an id, a scratch value, a Stableford value, and an NR flag.
  // The two values are independent so a player can rank well in one competition
  // and poorly in the other, exercising the "advances via either" branch (3.7).
  // Values are drawn from a small range so ties and boundary positions relative
  // to the cut value occur frequently. Ids are built from the array index so
  // every player id is distinct regardless of how many players are generated.
  const playerArb = (
    index: number,
  ): fc.Arbitrary<{
    playerId: string;
    scratchValue: number;
    stablefordValue: number;
    hasNRDay1: boolean;
  }> =>
    fc
      .record({
        scratchValue: fc.integer({ min: 0, max: 5 }),
        stablefordValue: fc.integer({ min: 0, max: 5 }),
        hasNRDay1: fc.boolean(),
      })
      .map(({ scratchValue, stablefordValue, hasNRDay1 }) => ({
        playerId: `p${index}`,
        scratchValue,
        stablefordValue,
        hasNRDay1,
      }));

  const rosterArb = fc.integer({ min: 1, max: 12 }).chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_unused, i) => playerArb(i)),
    ),
  );

  it('CUT iff Day 1 NR or position > X in both competitions (Requirements 3.4-3.7)', () => {
    fc.assert(
      fc.property(
        rosterArb,
        fc.integer({ min: 1, max: 15 }),
        (roster, cutValue) => {
          // Derive the two competitions' positions from the roster, using the
          // service's ranking (scratch on gross ascending, Stableford on points
          // descending). NR players receive a null position in both.
          const scratchPlayers: RankablePlayer[] = roster.map((p) => ({
            playerId: p.playerId,
            value: p.scratchValue,
            hasNRDay1: p.hasNRDay1,
          }));
          const stablefordPlayers: RankablePlayer[] = roster.map((p) => ({
            playerId: p.playerId,
            value: p.stablefordValue,
            hasNRDay1: p.hasNRDay1,
          }));

          const scratchPositions = rankScratch(scratchPlayers);
          const stablefordPositions = rankStableford(stablefordPlayers);
          const hasNRDay1 = new Map(
            roster.map((p) => [p.playerId, p.hasNRDay1] as const),
          );

          const cut = evaluateCut(
            cutValue,
            scratchPositions,
            stablefordPositions,
            hasNRDay1,
          );

          // (3.4) Every player in the roster receives a cut decision.
          for (const player of roster) {
            expect(cut.has(player.playerId)).toBe(true);
          }

          // Independent oracle for the expected decision, computed directly from
          // the positions rather than reusing the service's cut logic.
          for (const player of roster) {
            const scratch = scratchPositions.get(player.playerId) ?? null;
            const stableford = stablefordPositions.get(player.playerId) ?? null;

            const advances =
              !player.hasNRDay1 &&
              ((scratch !== null && scratch <= cutValue) ||
                (stableford !== null && stableford <= cutValue));

            const expectedCut = !advances;
            expect(cut.get(player.playerId)).toBe(expectedCut);

            // (3.5) A Day 1 NR player is always cut.
            if (player.hasNRDay1) {
              expect(cut.get(player.playerId)).toBe(true);
            }
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
