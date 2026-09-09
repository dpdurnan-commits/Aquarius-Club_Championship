/**
 * CourseSetupService — hole configuration (par + stroke index) and completeness.
 *
 * This service sits on top of the {@link Repository} and owns the validation and
 * gating rules for course setup (Requirement 1). The repository is pure
 * persistence: this layer enforces the validate-reject-retain discipline, the
 * stroke-index uniqueness rule, the completeness predicate, and withholding an
 * incomplete configuration from the Stableford calculator.
 *
 * Responsibilities:
 *  - `getHoles()` — read all 18 holes with current par/stroke index. (1.1)
 *  - `setPar(ordinal, par)` — accept integer par in [3, 6]; on invalid input
 *    reject, retain the stored value, and return the permitted range. On success
 *    persist and return a save confirmation. (1.2, 1.5, 1.6, 1.7)
 *  - `setStrokeIndex(ordinal, strokeIndex)` — accept integer in [1, 18] AND
 *    enforce uniqueness across the 18 holes; on duplicate reject, retain the
 *    stored value, and identify the conflicting hole; on invalid input reject,
 *    retain, and return the permitted range. On success persist and confirm.
 *    (1.3, 1.4, 1.5, 1.6, 1.7)
 *  - `isCourseComplete()` — true iff all 18 pars are valid integers in [3, 6]
 *    AND the 18 stroke indices are exactly a permutation of {1..18}. (1.8)
 *  - `getConfigForCalculator()` — return the course configuration for the
 *    Stableford calculator when complete, or an incomplete-configuration
 *    indication when not. (1.9)
 *
 * The service never mutates stored state on a rejected entry: validation runs
 * before any repository write, so a rejected par/stroke index leaves the
 * previously stored value untouched (retain-on-reject).
 */

import {
  HOLE_ORDINALS,
  PAR_MAX,
  PAR_MIN,
  STROKE_INDEX_MAX,
  STROKE_INDEX_MIN,
  err,
  ok,
  type Hole,
  type HoleOrdinal,
  type Par,
  type Result,
  type StrokeIndex,
  type CourseChangedEvent,
} from '@ccs/types';
import type { EventBroker } from './event-broker.js';
import type { Repository } from './repository.js';

/**
 * The course configuration handed to the Stableford calculator once the course
 * is complete. It carries the par and stroke index for every one of the 18
 * holes, keyed by ordinal. Only produced when {@link CourseSetupService.isCourseComplete}
 * is true, so every entry is guaranteed present and valid. (Requirements 1.8, 1.9)
 */
export interface CourseConfig {
  /** Par for each hole, keyed by ordinal — every entry present when complete. */
  readonly parByHole: ReadonlyMap<HoleOrdinal, Par>;
  /** Stroke index for each hole, keyed by ordinal — a permutation of {1..18}. */
  readonly strokeIndexByHole: ReadonlyMap<HoleOrdinal, StrokeIndex>;
}

/** Human-readable permitted-range message for par. (Requirement 1.5) */
const PAR_RANGE_MESSAGE = `Par must be an integer from ${PAR_MIN} to ${PAR_MAX}.`;

/** Human-readable permitted-range message for stroke index. (Requirement 1.5) */
const STROKE_INDEX_RANGE_MESSAGE = `Stroke index must be an integer from ${STROKE_INDEX_MIN} to ${STROKE_INDEX_MAX}.`;

/** True when `value` is an integer within the inclusive [min, max] range. */
function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Coordinates hole configuration on top of the {@link Repository}, enforcing the
 * Course Setup validation and gating rules (Requirement 1).
 */
export class CourseSetupService {
  private readonly repository: Repository;

  /**
   * Optional in-process event broker. When present, a `course-changed` event is
   * published after a successful par or stroke-index persistence so connected
   * displays refresh without a manual reload; when absent, publishing is
   * skipped. (Requirement 10.1, 10.2)
   */
  private readonly broker: EventBroker | undefined;

  constructor(repository: Repository, broker?: EventBroker) {
    this.repository = repository;
    this.broker = broker;
  }

  /**
   * Return all 18 holes with their current par and stroke index (null where a
   * value has not yet been configured). (Requirement 1.1)
   */
  getHoles(): Hole[] {
    return this.repository.getHoles();
  }

  /**
   * Validate and persist a hole's par. (Requirements 1.2, 1.5, 1.6, 1.7)
   *
   * Accepts an integer par in [3, 6]. On an empty, non-integer, or out-of-range
   * value the entry is rejected, the previously stored value is retained (no
   * write occurs), and the permitted range is returned. On success the value is
   * persisted and a save confirmation is returned.
   *
   * @param ordinal The hole ordinal (1..18) being configured.
   * @param par The candidate par value.
   * @returns Ok with a save-confirmation message, or an error carrying the
   *   permitted range.
   */
  setPar(ordinal: HoleOrdinal, par: Par): Result<string> {
    if (!isIntegerInRange(par, PAR_MIN, PAR_MAX)) {
      // Reject and retain the previously stored value (no write). (1.5)
      return err(PAR_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }

    // Valid: persist and make available to the calculator. (1.6, 1.7)
    this.repository.setPar(ordinal, par);

    // Persistence succeeded: fan out a course-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const parEvent: Omit<CourseChangedEvent, 'id'> = {
      type: 'course-changed',
      ordinal,
    };
    this.broker?.publish(parEvent);

    return ok(`Par saved for hole ${ordinal}.`);
  }

  /**
   * Validate and persist a hole's stroke index. (Requirements 1.3, 1.4, 1.5,
   * 1.6, 1.7)
   *
   * Accepts an integer stroke index in [1, 18] that is not already assigned to
   * another hole. On an empty, non-integer, or out-of-range value the entry is
   * rejected, the stored value retained, and the permitted range returned. On a
   * duplicate (the value is already held by a different hole) the entry is
   * rejected, the stored value retained, and the conflicting hole ordinal is
   * identified. On success the value is persisted and a save confirmation is
   * returned.
   *
   * @param ordinal The hole ordinal (1..18) being configured.
   * @param strokeIndex The candidate stroke index value.
   * @returns Ok with a save-confirmation message, or an error carrying either
   *   the permitted range or the conflicting hole ordinal.
   */
  setStrokeIndex(ordinal: HoleOrdinal, strokeIndex: StrokeIndex): Result<string> {
    if (!isIntegerInRange(strokeIndex, STROKE_INDEX_MIN, STROKE_INDEX_MAX)) {
      // Reject and retain the previously stored value (no write). (1.5)
      return err(STROKE_INDEX_RANGE_MESSAGE, 'OUT_OF_RANGE');
    }

    // Uniqueness: reject if another hole already holds this stroke index. (1.4)
    const conflict = this.repository
      .getHoles()
      .find(
        (hole) => hole.ordinal !== ordinal && hole.strokeIndex === strokeIndex,
      );
    if (conflict) {
      return err(
        `Stroke index ${strokeIndex} is already assigned to hole ${conflict.ordinal}.`,
        'DUPLICATE',
      );
    }

    // Valid and unique: persist and make available to the calculator. (1.6, 1.7)
    this.repository.setStrokeIndex(ordinal, strokeIndex);

    // Persistence succeeded: fan out a course-changed event so connected
    // displays recompute and refresh without a manual reload. (10.1, 10.2)
    const strokeIndexEvent: Omit<CourseChangedEvent, 'id'> = {
      type: 'course-changed',
      ordinal,
    };
    this.broker?.publish(strokeIndexEvent);

    return ok(`Stroke index saved for hole ${ordinal}.`);
  }

  /**
   * Whether the course configuration is complete. (Requirement 1.8)
   *
   * Complete iff all 18 pars are valid integers in [3, 6] AND the 18 stroke
   * indices form a complete set of {1..18} with no duplicates or omissions.
   * The repository's uniqueness constraint prevents duplicate stored stroke
   * indices, so completeness reduces to "every par valid and every stroke index
   * present"; the permutation check is still verified explicitly here so the
   * predicate is self-contained.
   */
  isCourseComplete(): boolean {
    const holes = this.repository.getHoles();

    // Every hole must have a par in the valid range. (1.8)
    const allParsValid = holes.every((hole) =>
      isIntegerInRange(hole.par, PAR_MIN, PAR_MAX),
    );
    if (!allParsValid) {
      return false;
    }

    // The 18 stroke indices must be exactly a permutation of {1..18}. (1.8)
    const strokeIndices = holes.map((hole) => hole.strokeIndex);
    if (strokeIndices.some((si) => si === null || si === undefined)) {
      return false;
    }
    const distinct = new Set(strokeIndices);
    if (distinct.size !== HOLE_ORDINALS.length) {
      return false; // A duplicate collapsed the set — not a permutation.
    }
    for (let value = STROKE_INDEX_MIN; value <= STROKE_INDEX_MAX; value += 1) {
      if (!distinct.has(value as StrokeIndex)) {
        return false; // An omission — {1..18} is not fully covered.
      }
    }

    return true;
  }

  /**
   * Return the course configuration for the Stableford calculator, gated on
   * completeness. (Requirement 1.9)
   *
   * When the course is complete, returns Ok with a {@link CourseConfig} carrying
   * every hole's par and stroke index. When incomplete, the configuration is
   * withheld and an INCOMPLETE_CONFIGURATION error is returned instead, so
   * downstream scoring never runs against a partial course.
   *
   * @returns Ok with the complete course configuration, or an
   *   incomplete-configuration error.
   */
  getConfigForCalculator(): Result<CourseConfig> {
    if (!this.isCourseComplete()) {
      return err(
        'Course configuration is incomplete: all 18 pars and a full set of stroke indices 1..18 are required.',
        'INCOMPLETE_CONFIGURATION',
      );
    }

    const holes = this.repository.getHoles();
    const parByHole = new Map<HoleOrdinal, Par>();
    const strokeIndexByHole = new Map<HoleOrdinal, StrokeIndex>();
    for (const hole of holes) {
      // Completeness guarantees both are present and valid.
      parByHole.set(hole.ordinal, hole.par as Par);
      strokeIndexByHole.set(hole.ordinal, hole.strokeIndex as StrokeIndex);
    }

    return ok({ parByHole, strokeIndexByHole });
  }
}
