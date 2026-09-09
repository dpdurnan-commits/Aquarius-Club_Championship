import { describe, it, expect, beforeEach } from 'vitest';
import { HOLE_ORDINALS } from '@ccs/types';
import { openDatabase } from './db.js';
import { Repository } from './repository.js';
import { CourseSetupService } from './course-setup-service.js';

/**
 * Feature: club-championship-scoring
 * Concrete unit test — 18-hole slot presence.
 *
 * Requirement 1.1: THE Course_Setup_Module SHALL provide entry for exactly 18
 * holes, each identified by a unique Hole_Ordinal from 1 to 18.
 *
 * These are example-based assertions (not property-based). They drive the real
 * CourseSetupService over a freshly seeded in-memory SQLite Repository, so they
 * confirm the actual seeded behaviour: exactly 18 hole slots keyed by a complete
 * set of ordinals 1..18 with no duplicates and no omissions.
 */
describe('CourseSetupService — 18-hole slot presence (Requirement 1.1)', () => {
  let service: CourseSetupService;

  beforeEach(() => {
    const repository = new Repository(openDatabase(':memory:'));
    service = new CourseSetupService(repository);
  });

  it('provides exactly 18 hole slots', () => {
    expect(service.getHoles()).toHaveLength(18);
  });

  it('keys the slots by ordinals 1..18 in ascending order', () => {
    const ordinals = service.getHoles().map((hole) => hole.ordinal);
    expect(ordinals).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });

  it('has a unique ordinal per slot with no duplicates', () => {
    const ordinals = service.getHoles().map((hole) => hole.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('covers the complete set of expected ordinals with no omissions', () => {
    const ordinals = new Set(service.getHoles().map((hole) => hole.ordinal));
    for (const expected of HOLE_ORDINALS) {
      expect(ordinals.has(expected)).toBe(true);
    }
    expect(ordinals.size).toBe(HOLE_ORDINALS.length);
  });
});
