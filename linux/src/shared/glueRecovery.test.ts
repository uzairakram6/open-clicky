import { describe, expect, it } from 'vitest';
import { recoverGluedEnglish, segmentGluedRun } from './glueRecovery';

describe('glueRecovery', () => {
  it('segments a long glued email summary', () => {
    const glued = 'yournewestemaillookslikeadocumentattachmentfromyouwithnosubject';
    const spaced = segmentGluedRun(glued);
    expect(spaced).toMatch(/your/);
    expect(spaced).toMatch(/email/);
    expect(spaced).toMatch(/attachment/);
    expect(spaced).toContain(' ');
  });

  it('recoverGluedEnglish leaves short tokens alone', () => {
    expect(recoverGluedEnglish('Done.')).toBe('Done.');
  });
});
