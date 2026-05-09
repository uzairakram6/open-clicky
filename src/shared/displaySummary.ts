export interface DisplayDetail {
  label: string;
  value: string;
}

export interface DisplaySummary {
  header: string;
  caption: string;
  details?: DisplayDetail[];
}

export function squashDisplayWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function trimDisplayText(value: string, maxChars: number): string {
  const text = squashDisplayWhitespace(value);
  if (text.length <= maxChars) return text;

  const sentenceEnd = Math.max(
    text.lastIndexOf('.', maxChars - 1),
    text.lastIndexOf('!', maxChars - 1),
    text.lastIndexOf('?', maxChars - 1)
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.55)) {
    return text.slice(0, sentenceEnd + 1).trim();
  }

  const cut = text.slice(0, Math.max(1, maxChars - 1));
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace >= Math.floor(maxChars * 0.55) ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

export function compactDisplaySummary(summary: DisplaySummary): DisplaySummary {
  const details = summary.details
    ?.map((detail) => ({
      label: squashDisplayWhitespace(detail.label),
      value: squashDisplayWhitespace(detail.value)
    }))
    .filter((detail) => detail.label && detail.value);

  return {
    header: trimDisplayText(summary.header, 52),
    caption: trimDisplayText(summary.caption, 118),
    details: details?.length ? details : undefined
  };
}
