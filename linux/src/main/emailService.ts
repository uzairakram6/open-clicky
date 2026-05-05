import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { writeFile } from 'node:fs/promises';
import type { EmailConfig, EmailSummary } from '../shared/types';

const providerDefaults: Record<string, { host: string; port: number }> = {
  gmail: { host: 'imap.gmail.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 }
};

export async function fetchRecentEmails(
  config: EmailConfig,
  maxEmails = 5
): Promise<EmailSummary[]> {
  if (!config.enabled || !config.username || !config.password) {
    throw new Error('Email not configured. Please add your email credentials in settings.');
  }

  const defaults = providerDefaults[config.provider];
  const host = config.imapHost ?? defaults?.host ?? config.imapHost;
  const port = config.imapPort ?? defaults?.port ?? 993;

  if (!host) {
    throw new Error(`Unknown email provider: ${config.provider}. Please set a custom IMAP host.`);
  }

  const imap = new Imap({
    user: config.username,
    password: config.password,
    host,
    port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve, reject) => {
    const emails: EmailSummary[] = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) {
          imap.end();
          reject(new Error(`Failed to open inbox: ${err.message}`));
          return;
        }

        imap.search(['ALL'], (err, results) => {
          if (err) {
            imap.end();
            reject(new Error(`Search failed: ${err.message}`));
            return;
          }

          if (!results || results.length === 0) {
            imap.end();
            resolve([]);
            return;
          }

          const recent = results.slice(-maxEmails);
          const fetch = imap.fetch(recent, { bodies: '' });

          fetch.on('message', (msg, seqno) => {
            let uid: number | undefined;
            msg.on('attributes', (attrs) => {
              uid = attrs.uid;
            });

            let buffer = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
            });

            msg.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                emails.push({
                  from: parsed.from?.text ?? 'Unknown',
                  subject: parsed.subject ?? '(No subject)',
                  date: parsed.date?.toISOString() ?? '',
                  preview: parsed.text?.slice(0, 300).replace(/\s+/g, ' ').trim() ?? '',
                  attachments: parsed.attachments?.map((a) => a.filename).filter((f): f is string => !!f) ?? [],
                  uid: uid ?? seqno
                });
              } catch {
                void 0;
              }
            });
          });

          fetch.once('error', (err) => {
            imap.end();
            reject(new Error(`Fetch failed: ${err.message}`));
          });

          fetch.once('end', () => {
            imap.end();
          });
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error(`IMAP connection failed: ${err.message}`));
    });

    imap.once('end', () => {
      resolve(emails.reverse());
    });

    imap.connect();
  });
}

export async function downloadAttachment(
  config: EmailConfig,
  uid: number,
  filename: string,
  destPath: string
): Promise<void> {
  if (!config.enabled || !config.username || !config.password) {
    throw new Error('Email not configured.');
  }

  const defaults = providerDefaults[config.provider];
  const host = config.imapHost ?? defaults?.host ?? config.imapHost;
  const port = config.imapPort ?? defaults?.port ?? 993;

  if (!host) {
    throw new Error(`Unknown email provider: ${config.provider}.`);
  }

  const imap = new Imap({
    user: config.username,
    password: config.password,
    host,
    port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve, reject) => {
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) {
          imap.end();
          reject(new Error(`Failed to open inbox: ${err.message}`));
          return;
        }

        const fetch = imap.fetch([uid], { bodies: '' });
        let buffer = '';

        fetch.on('message', (msg: any) => {
          msg.on('body', (stream: any) => {
            stream.on('data', (chunk: any) => {
              buffer += chunk.toString('utf8');
            });
          });

          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(buffer);
              const attachment = parsed.attachments?.find((a) => a.filename === filename);
              if (!attachment) {
                reject(new Error(`Attachment "${filename}" not found in email ${uid}.`));
                return;
              }
              await writeFile(destPath, attachment.content);
              resolve();
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });

        fetch.once('error', (err: any) => {
          imap.end();
          reject(new Error(`Fetch failed: ${err.message}`));
        });

        fetch.once('end', () => {
          imap.end();
        });
      });
    });

    imap.once('error', (err) => {
      reject(new Error(`IMAP connection failed: ${err.message}`));
    });

    imap.connect();
  });
}
