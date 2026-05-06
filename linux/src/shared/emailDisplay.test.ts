import { describe, expect, it } from 'vitest';
import { buildRecentEmailDisplaySummary } from './emailDisplay';
import type { EmailSummary } from './types';

function email(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    from: 'AssemblyAI <hello@assemblyai.com>',
    subject: 'LLM Gateway with fallbacks, streaming tool calling, and 0% markup',
    date: '2026-05-07T00:00:00.000Z',
    preview: '',
    attachments: [],
    uid: 1,
    ...overrides
  };
}

describe('buildRecentEmailDisplaySummary', () => {
  it('builds spaced deterministic UI text for the latest email', () => {
    expect(buildRecentEmailDisplaySummary([email()])).toMatchObject({
      header: 'Most Recent Email',
      caption: 'AssemblyAI sent an email about LLM Gateway with fallbacks, streaming tool calling, and 0% markup.'
    });
  });

  it('does not concatenate header or caption words', () => {
    const out = buildRecentEmailDisplaySummary([email()]);
    expect(out.header).toMatch(/\bMost Recent Email\b/);
    expect(out.caption).toMatch(/\bAssemblyAI sent an email about\b/);
    expect(out.caption).toMatch(/\bstreaming tool calling\b/);
  });

  it('keeps full metadata in details instead of the compact caption', () => {
    const out = buildRecentEmailDisplaySummary([email({ preview: 'Every major LLM provider is included in one key.' })]);
    expect(out.details).toEqual([
      { label: 'From', value: 'AssemblyAI <hello@assemblyai.com>' },
      { label: 'Subject', value: 'LLM Gateway with fallbacks, streaming tool calling, and 0% markup' },
      { label: 'Preview', value: 'Every major LLM provider is included in one key.' },
      { label: 'Attachments', value: 'None' }
    ]);
  });

  it('uses a stable empty-inbox message', () => {
    expect(buildRecentEmailDisplaySummary([])).toEqual({
      header: 'No Recent Emails',
      caption: 'No emails were found in your inbox.'
    });
  });
});
