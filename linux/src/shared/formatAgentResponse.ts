import { stripPointTags } from './pointTags';

/** Common greetings / phrases streaming sometimes omits spaces between. */
const GLUED_PHRASES: Array<[RegExp, string]> = [
  [/\bgotit\b/gi, 'Got it'],
  [/\btodayis\b/gi, 'today is'],
  [/\bhereyougo\b/gi, 'here you go'],
  [/\biswhat\b/gi, 'is what'],
  [/\bysure\b/gi, 'sure']
];

const GLUED_WORD_PARTS = new Set([
  'a', 'an', 'and', 'app', 'at', 'build', 'check', 'coffee', 'command', 'desktop', 'done', 'email', 'file', 'files', 'for',
  'from', 'in', 'is', 'it', 'landing', 'latest', 'looks', 'mail', 'make', 'message', 'minimal', 'new', 'of', 'on', 'open',
  'page', 'sent', 'shop', 'task', 'tasks', 'text', 'that', 'the', 'this', 'to', 'up', 'update', 'voice', 'web', 'with', 'work', 'working', 'you', 'your'
]);

function splitGluedLowercaseToken(token: string): string {
  if (!/^[a-z]{14,}$/.test(token)) return token;

  const n = token.length;
  const bestScore = new Array<number>(n + 1).fill(Number.NEGATIVE_INFINITY);
  const prev = new Array<number>(n + 1).fill(-1);
  bestScore[0] = 0;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(bestScore[i])) continue;
    for (let j = i + 1; j <= Math.min(n, i + 16); j++) {
      const part = token.slice(i, j);
      const isKnown = GLUED_WORD_PARTS.has(part);
      const score = bestScore[i] + (isKnown ? part.length : -2.2);
      if (score > bestScore[j]) {
        bestScore[j] = score;
        prev[j] = i;
      }
    }
  }

  if (!Number.isFinite(bestScore[n]) || prev[n] < 0) return token;

  const parts: string[] = [];
  let idx = n;
  let covered = 0;
  while (idx > 0) {
    const start = prev[idx];
    if (start < 0) return token;
    const part = token.slice(start, idx);
    if (GLUED_WORD_PARTS.has(part)) covered += part.length;
    parts.push(part);
    idx = start;
  }
  parts.reverse();

  // Keep this conservative so we avoid damaging normal words.
  if (covered / n < 0.7 || parts.length < 3) return token;
  return parts.join(' ');
}

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
  s = s.replace(/\b[a-z]{14,}\b/g, (token) => splitGluedLowercaseToken(token));

  s = s.replace(/,([^\d\s])/g, ', $1');
  s = s.replace(/(\d),(\d{4})\b/g, '$1, $2');

  s = s.replace(/\s+/g, ' ').trim();

  return s.replace(/\s+/g, ' ').trim();
}
