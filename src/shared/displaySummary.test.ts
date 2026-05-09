import { describe, expect, it } from 'vitest';
import { compactDisplaySummary, trimDisplayText } from './displaySummary';

describe('displaySummary', () => {
  it('trims compact captions at sentence boundaries when possible', () => {
    expect(trimDisplayText('First sentence is enough. Second sentence is too much for the compact card.', 34)).toBe(
      'First sentence is enough.'
    );
  });

  it('trims compact captions at word boundaries otherwise', () => {
    expect(trimDisplayText('This caption has no early sentence boundary and should be shortened cleanly', 48)).toBe(
      'This caption has no early sentence boundary…'
    );
  });

  it('normalizes and filters structured details', () => {
    expect(compactDisplaySummary({
      header: '  Build   Complete  ',
      caption: '  The   app   was   built.  ',
      details: [
        { label: ' Path ', value: ' /tmp/clicky_apps/demo ' },
        { label: ' Empty ', value: '   ' }
      ]
    })).toEqual({
      header: 'Build Complete',
      caption: 'The app was built.',
      details: [{ label: 'Path', value: '/tmp/clicky_apps/demo' }]
    });
  });
});
