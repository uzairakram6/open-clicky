import { describe, expect, it } from 'vitest';
import { stripPointTags } from './pointTags';

describe('stripPointTags', () => {
  it('removes point tags from visible and spoken text', () => {
    expect(stripPointTags('Open that [POINT:button.submit] and continue')).toBe('Open that and continue');
  });
});
