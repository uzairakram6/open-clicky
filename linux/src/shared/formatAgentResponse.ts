import { stripPointTags } from './pointTags';

/** Common greetings / phrases streaming sometimes omits spaces between. */
const GLUED_PHRASES: Array<[RegExp, string]> = [
  [/\bgotit\b/gi, 'Got it'],
  [/\btodayis\b/gi, 'today is'],
  [/\bhereyougo\b/gi, 'here you go'],
  [/\biswhat\b/gi, 'is what'],
  [/\bysure\b/gi, 'sure']
];

export function formatAgentResponseForDisplay(raw: string): string {
  let s = stripPointTags(raw).trim();
  if (!s) return '';

  for (const [re, rep] of GLUED_PHRASES) {
    s = s.replace(re, rep);
  }

  s = s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');

  let prev = '';
  for (let i = 0; i < 5 && prev !== s; i++) {
    prev = s;
    s = s.replace(/\*([^*\n]+?)\*/g, '$1');
  }
  s = s.replace(/\*/g, '');

  s = s.replace(/`([^`]+)`/g, '$1');

  s = s.replace(/\b([a-z]{2,})([A-Z][a-z]+)\b/g, '$1 $2');
  s = s.replace(/([A-Za-z])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([A-Za-z])/g, '$1 $2');

  s = s.replace(/,([^\d\s])/g, ', $1');
  s = s.replace(/(\d),(\d{4})\b/g, '$1, $2');

  s = s.replace(/\s+/g, ' ').trim();

  return s.replace(/\s+/g, ' ').trim();
}
