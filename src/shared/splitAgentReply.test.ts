import { describe, expect, it } from 'vitest';
import { splitAgentReply } from './splitAgentReply';

describe('splitAgentReply', () => {
  it('splits tagged header caption and spoken body', () => {
    const raw =
      '<<<HEADER>>>\nInbox update\n<<<UI>>>\nYour latest email has a Word attachment.\n<<<SPOKEN>>>\nHey — I checked your inbox.';
    const out = splitAgentReply(raw);
    expect(out.displayHeader).toBe('Inbox update');
    expect(out.displayCaption).toBe('Your latest email has a Word attachment.');
    expect(out.spokenText).toMatch(/^Hey — I checked your inbox/);
  });

  it('splits UI and spoken without header (backward compatible)', () => {
    const raw =
      '<<<UI>>>\nYour latest email has a Word attachment.\n<<<SPOKEN>>>\nHey — I checked your inbox. The newest message is …';
    const out = splitAgentReply(raw);
    expect(out.displayHeader).toBe('');
    expect(out.displayCaption).toBe('Your latest email has a Word attachment.');
    expect(out.spokenText).toMatch(/^Hey — I checked your inbox/);
  });

  it('treats untagged reply as spoken only', () => {
    const raw = 'Just the spoken part without markers.';
    expect(splitAgentReply(raw)).toEqual({
      displayHeader: '',
      displayCaption: '',
      spokenText: raw
    });
  });

  it('drops orphan markers in legacy bodies', () => {
    expect(splitAgentReply('<<<UI>>> only markers')).toEqual({
      displayHeader: '',
      displayCaption: '',
      spokenText: 'only markers'
    });
  });
});
