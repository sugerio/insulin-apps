import { describe, expect, it } from 'vitest';
import * as contracts from '../../src/app/shared/index.ts';

describe('contracts', () => {
  it('loads', () => {
    expect(contracts).toBeTypeOf('object');
  });
});
