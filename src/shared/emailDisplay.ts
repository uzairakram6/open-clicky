import type { EmailSummary } from './types';
import { compactDisplaySummary, squashDisplayWhitespace, type DisplaySummary } from './displaySummary';

function readableSender(from: string): string {
  const text = squashDisplayWhitespace(from);
  if (!text) return 'Unknown sender';

  const nameMatch = text.match(/^"?([^"<]+?)"?\s*</);
  if (nameMatch?.[1]?.trim()) {
    return squashDisplayWhitespace(nameMatch[1]);
  }

  const emailMatch = text.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (emailMatch?.[1]) {
    return emailMatch[1]
      .split('.')[0]
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
      .join(' ');
  }

  return text;
}

function readableSubject(email: EmailSummary): string {
  const subject = squashDisplayWhitespace(email.subject);
  if (subject && subject !== '(No subject)') return subject;

  if (email.attachments.length > 0) {
    return `${email.attachments.length} attachment${email.attachments.length === 1 ? '' : 's'}`;
  }

  const preview = squashDisplayWhitespace(email.preview);
  return preview || 'no subject';
}

export function buildRecentEmailDisplaySummary(emails: EmailSummary[]): DisplaySummary {
  if (emails.length === 0) {
    return compactDisplaySummary({
      header: 'No Recent Emails',
      caption: 'No emails were found in your inbox.'
    });
  }

  const latest = emails[0];
  const sender = readableSender(latest.from);
  const subject = readableSubject(latest);
  const attachmentText = latest.attachments.length > 0
    ? ` It has ${latest.attachments.length} attachment${latest.attachments.length === 1 ? '' : 's'}.`
    : '';

  return compactDisplaySummary({
    header: 'Most Recent Email',
    caption: `${sender} sent an email about ${subject}.${attachmentText}`,
    details: [
      { label: 'From', value: latest.from },
      { label: 'Subject', value: latest.subject || '(No subject)' },
      { label: 'Preview', value: latest.preview },
      { label: 'Attachments', value: latest.attachments.length ? latest.attachments.join(', ') : 'None' }
    ]
  });
}
