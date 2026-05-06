import { stripPointTags } from './pointTags';

const MARK_HEADER = '<<<HEADER>>>';
const MARK_UI = '<<<UI>>>';
const MARK_SPOKEN = '<<<SPOKEN>>>';

export interface SplitAgentReply {
  displayHeader: string;
  displayCaption: string;
  spokenText: string;
}

function squashWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Parses the assistant reply into header bar text, caption, and full spoken/TTS body.
 */
export function splitAgentReply(raw: string): SplitAgentReply {
  const text = stripPointTags(raw).trim();
  if (!text) {
    return { displayHeader: '', displayCaption: '', spokenText: '' };
  }

  const ih = text.indexOf(MARK_HEADER);
  const iu = text.indexOf(MARK_UI);
  const ispo = text.indexOf(MARK_SPOKEN);

  if (ih !== -1 && iu !== -1 && ispo !== -1 && ih < iu && iu < ispo) {
    const displayHeader = squashWs(text.slice(ih + MARK_HEADER.length, iu));
    const displayCaption = squashWs(text.slice(iu + MARK_UI.length, ispo));
    let spokenText = text.slice(ispo + MARK_SPOKEN.length).trim();
    if (!spokenText) {
      spokenText = displayCaption || displayHeader || text;
    }
    return { displayHeader, displayCaption, spokenText };
  }

  if (iu !== -1 && ispo !== -1 && iu < ispo) {
    const displayCaption = squashWs(text.slice(iu + MARK_UI.length, ispo));
    let spokenText = text.slice(ispo + MARK_SPOKEN.length).trim();
    if (!spokenText) {
      spokenText = displayCaption || text;
    }
    return { displayHeader: '', displayCaption, spokenText };
  }

  const spokenText = text
    .replace(/<<<HEADER>>>/g, '')
    .replace(/<<<UI>>>/g, '')
    .replace(/<<<SPOKEN>>>/g, '')
    .trim();
  return { displayHeader: '', displayCaption: '', spokenText };
}
