import { describe, it, expect } from 'vitest';
import { availableDays } from './index.js';

describe('server scaffold', () => {
  it('exposes the two competition days from shared types', () => {
    expect(availableDays()).toEqual([1, 2]);
  });
});
