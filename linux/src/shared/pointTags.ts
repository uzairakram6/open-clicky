const POINT_TAG_PATTERN = /\[POINT:[^\]]*]/gi;

export function stripPointTagsPreserveWhitespace(input: string): string {
  return input.replace(POINT_TAG_PATTERN, '').replace(/[ \t]{2,}/g, ' ');
}

export function stripPointTags(input: string): string {
  return stripPointTagsPreserveWhitespace(input).trim();
}
