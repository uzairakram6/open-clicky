import { describe, expect, it } from 'vitest';
import { buildTaskAcknowledgement, cleanAcknowledgementSpeech } from './acknowledgement';

describe('buildTaskAcknowledgement', () => {
  it('acknowledges a build task without echoing the raw transcript', () => {
    expect(buildTaskAcknowledgement('Clicky, go and build a timer app')).toBe(
      "Got it. I'll start building that now."
    );
  });

  it('falls back when the transcript has no usable task', () => {
    expect(buildTaskAcknowledgement('   ')).toBe("Got it. I'll start on that now.");
  });

  it('keeps long acknowledgements short and meaningful for speech', () => {
    const acknowledgement = buildTaskAcknowledgement(
      'Please can you analyze this very long project folder and explain every source file and every dependency in detail before changing anything'
    );

    expect(acknowledgement.length).toBeLessThanOrEqual(128);
    expect(acknowledgement).toBe("Got it. I'll take a look and summarize what matters.");
  });

  it('uses a generic acknowledgement for noisy transcripts instead of speaking gibberish', () => {
    expect(buildTaskAcknowledgement('clicky, ### $$$ ```const x = () => {}```')).toBe(
      "Got it. I'll take care of that now."
    );
  });

  it('sanitizes content that speech engines pronounce poorly', () => {
    expect(cleanAcknowledgementSpeech('Open https://example.com/a?x=1 and run `npm test` # now')).toBe(
      'Open link and run now'
    );
  });
});
