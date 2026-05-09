import { describe, expect, it } from 'vitest';
import { stripPointTags, stripPointTagsPreserveWhitespace } from './pointTags';

describe('stripPointTags', () => {
  it('removes point tags from visible and spoken text', () => {
    expect(stripPointTags('Open that [POINT:button.submit] and continue')).toBe('Open that and continue');
  });

  it('can preserve chunk boundary whitespace for streamed text', () => {
    expect(stripPointTagsPreserveWhitespace(' READ[POINT:x] ')).toBe(' READ ');
    expect(`${stripPointTagsPreserveWhitespace('READ')}${stripPointTagsPreserveWhitespace(' THE ATTACHMENT')}`)
      .toBe('READ THE ATTACHMENT');
  });
});
