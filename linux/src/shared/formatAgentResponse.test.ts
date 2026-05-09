import { describe, expect, it } from 'vitest';
import { formatAgentResponseForDisplay } from './formatAgentResponse';

describe('formatAgentResponseForDisplay', () => {
  it('strips markdown emphasis and fixes tight date text', () => {
    const raw = 'Gotit—todayis**Wednesday,May6,2026at23:17:52PKT**.';
    expect(formatAgentResponseForDisplay(raw)).toBe(
      'Got it—today is Wednesday, May 6, 2026 at 23:17:52 PKT.'
    );
  });

  it('removes point tags and normalizes whitespace', () => {
    expect(formatAgentResponseForDisplay('Hello[POINT:x]  world')).toBe('Hello world');
  });

  it('handles single-asterisk emphasis', () => {
    expect(formatAgentResponseForDisplay('See *this* value')).toBe('See this value');
  });

  it('spaces out long glued letter-only captions after formatting', () => {
    const out = formatAgentResponseForDisplay('tasksforaminimalcoffeeshoplandingpageapp');
    expect(out).toBe('tasks for a minimal coffee shop landing page app');
  });

  it('does not split valid words while trying to repair display text', () => {
    const raw = 'your latest email is from assembly ai about llm gateway updates, fallback, streaming tooling, and zero markup.';
    expect(formatAgentResponseForDisplay(raw)).toBe(raw);
  });

  it('preserves proper nouns and acronyms in email summaries', () => {
    const raw = 'Your latest email is from Assembly AI about LLM gateway updates, fallback, streaming tooling, and zero markup.';
    expect(formatAgentResponseForDisplay(raw)).toBe(raw);
  });
});
