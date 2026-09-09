/**
 * RankingAndCutService — pure ranking and cut logic (no I/O, deterministic).
 *
 * This module ranks players across the two Day 1 competitions and evaluates the
 * cut applied when Day 1 is marked complete. Every function here is a pure
 * function of its arguments so it can be property-tested in isolation. The
 * service works over already-derived per-player values (Day 1 aggregate gross,
 * Day 1 aggregate Stableford, and the "has NR on Day 1" predicate), which the
 * caller produces via the day-aggregation helpers.
 *
 * This file implements standard competition ranking (Requirement 6) and cut
 * evaluation (Requirement 3). All functions live in this single module so the
 * property tests (subtasks 4.2, 4.3, 4.5) can be added alongside it later.
 */

/**
 * A player's competition position: a 1-based rank, or `null` when the player is
 * unranked (any player with a No_Return status on Day 1). (Requirements 6.3, 8.13)
 */
export type CompetitionPosition = number | null;

/** Map from player id to that player's competition position (or null). */
export type PositionsByPlayer = ReadonlyMap<string, CompetitionPosition>;

/** Map from player id to whether that player is CUT (true) or advances (false). */
export type CutByPlayer = ReadonlyMap<string, boolean>;

/** Sort direction for the ranked value. */
type RankOrder = 'asc' | 'desc';

/**
 * A player paired with the numeric value being ranked, plus whether the player
 * has a No_Return status on Day 1. NR players are excluded from ranking and
 * assigned a `null` position regardless of their value. (Requirement 6.3)
 */
export interface RankablePlayer {
  readonly playerId: string;
  /** The Day 1 aggregate value being ranked (gross for scratch, Stableford for stableford). */
  readonly value: number;
  /** Whether the player has any Day 1 No_Return; NR players are unranked. */
  readonly hasNRDay1: boolean;
}

/**
 * Standard competition ranking with ties, over the ranked (non-NR) players.
 *
 * Players are sorted by `value` in the given order; equal values share the same
 * position, and the next distinct value's position skips by the size of the
 * preceding tie group (for example 1, 2, 2, 4). The best value receives
 * position 1. NR players are excluded from the sort and assigned a `null`
 * position. (Requirements 6.1, 6.2, 6.3; design `rank(playersWithValue, order)`)
 *
 * @param players The players to rank, each with a value and NR flag.
 * @param order `'asc'` (lowest value = position 1, for scratch gross) or
 *   `'desc'` (highest value = position 1, for Stableford).
 * @returns A map from player id to position, with `null` for NR players.
 */
function rank(
  players: readonly RankablePlayer[],
  order: RankOrder,
): PositionsByPlayer {
  const positions = new Map<string, CompetitionPosition>();

  // NR players are unranked in both competitions. (6.3)
  for (const player of players) {
    if (player.hasNRDay1) {
      positions.set(player.playerId, null);
    }
  }

  const ranked = players
    .filter((player) => !player.hasNRDay1)
    .sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value));

  // Standard competition ranking: ties share a position, the next position
  // skips by the size of the preceding tie group (1, 2, 2, 4). (6.1, 6.2)
  let index = 0;
  while (index < ranked.length) {
    let last = index;
    while (
      last + 1 < ranked.length &&
      ranked[last + 1]!.value === ranked[index]!.value
    ) {
      last += 1;
    }
    const sharedPosition = index + 1; // 1-based; best value gets position 1.
    for (let k = index; k <= last; k += 1) {
      positions.set(ranked[k]!.playerId, sharedPosition);
    }
    index = last + 1;
  }

  return positions;
}

/**
 * Rank players in the Scratch Strokeplay competition by Day 1 aggregate gross
 * ascending — the lowest total receives position 1 — using standard competition
 * ranking with ties. Players with a Day 1 No_Return are excluded and assigned a
 * `null` position. (Requirements 6.1, 6.3)
 *
 * @param players The players to rank, `value` being each player's Day 1
 *   aggregate gross strokes.
 * @returns A map from player id to scratch position (or null for NR players).
 */
export function rankScratch(
  players: readonly RankablePlayer[],
): PositionsByPlayer {
  return rank(players, 'asc');
}

/**
 * Rank players in the Stableford competition by Day 1 aggregate Stableford
 * descending — the highest total receives position 1 — using standard
 * competition ranking with ties. Players with a Day 1 No_Return are excluded and
 * assigned a `null` position. (Requirements 6.2, 6.3)
 *
 * @param players The players to rank, `value` being each player's Day 1
 *   aggregate Stableford points.
 * @returns A map from player id to Stableford position (or null for NR players).
 */
export function rankStableford(
  players: readonly RankablePlayer[],
): PositionsByPlayer {
  return rank(players, 'desc');
}

/**
 * Evaluate the cut applied when Day 1 is marked complete. (Requirement 3)
 *
 * A player is CUT when:
 *  - the player has a Day 1 No_Return (NR players are never ranked, so their
 *    positions are null and this branch always cuts them), or (3.5)
 *  - the player's position is greater than the cut value X in BOTH the Scratch
 *    Strokeplay and Stableford competitions. (3.6)
 *
 * A player advances (not cut) when the player has no Day 1 No_Return and has a
 * position less than or equal to X in at least one competition. (3.7)
 *
 * @param cutValue The positive-integer cut threshold X entered by the admin.
 * @param scratchPositions Scratch positions by player (null for NR/unranked).
 * @param stablefordPositions Stableford positions by player (null for NR/unranked).
 * @param hasNRDay1 Whether each player has a Day 1 No_Return, by player id.
 * @returns A map from player id to `true` (CUT) or `false` (advances).
 */
export function evaluateCut(
  cutValue: number,
  scratchPositions: PositionsByPlayer,
  stablefordPositions: PositionsByPlayer,
  hasNRDay1: ReadonlyMap<string, boolean>,
): CutByPlayer {
  const cut = new Map<string, boolean>();

  // The full roster is the union of every player id we have information for, so
  // a player appearing only in the NR map (never ranked) is still evaluated.
  const playerIds = new Set<string>([
    ...scratchPositions.keys(),
    ...stablefordPositions.keys(),
    ...hasNRDay1.keys(),
  ]);

  for (const playerId of playerIds) {
    if (hasNRDay1.get(playerId) === true) {
      cut.set(playerId, true); // Day 1 NR is always cut. (3.5)
      continue;
    }

    const scratch = scratchPositions.get(playerId) ?? null;
    const stableford = stablefordPositions.get(playerId) ?? null;

    // Advances if within the top X in at least one competition. (3.7)
    const advances =
      (scratch !== null && scratch <= cutValue) ||
      (stableford !== null && stableford <= cutValue);

    cut.set(playerId, !advances); // Otherwise CUT. (3.6)
  }

  return cut;
}
