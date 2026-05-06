const MAX_SPOKEN_ACK_CHARS = 96;

const INTENT_ACKNOWLEDGEMENTS: Array<{ pattern: RegExp; response: string }> = [
  {
    pattern: /\b(build|create|make|generate|code|design|website|app|game|tool|script)\b/i,
    response: "Got it. I'll start building that now."
  },
  {
    pattern: /\b(open|launch|visit|go to|navigate|browser|website|url|link)\b/i,
    response: "Got it. I'll open that up."
  },
  {
    pattern: /\b(email|mail|inbox|message|attachment|attachments)\b/i,
    response: "Got it. I'll check that for you."
  },
  {
    pattern: /\b(summarize|explain|analyze|review|inspect|look at|read)\b/i,
    response: "Got it. I'll take a look and summarize what matters."
  },
  {
    pattern: /\b(change|update|edit|modify|fix|refactor|improve|adjust)\b/i,
    response: "Got it. I'll make that change."
  },
  {
    pattern: /\b(find|search|look up|research)\b/i,
    response: "Got it. I'll look that up."
  },
  {
    pattern: /\b(run|execute|terminal|command|shell|install|test)\b/i,
    response: "Got it. I'll run that for you."
  }
];

export function buildTaskAcknowledgement(transcript: string): string {
  const task = cleanTranscriptForIntent(transcript);
  if (!hasUsableTask(task)) {
    return "Got it. I'll start on that now.";
  }

  const intent = INTENT_ACKNOWLEDGEMENTS.find(({ pattern }) => pattern.test(task));
  if (intent) {
    return intent.response;
  }

  return "Got it. I'll take care of that now.";
}

export function cleanAcknowledgementSpeech(text: string, maxChars = MAX_SPOKEN_ACK_CHARS): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, ' email address ')
    .replace(/[<>{}[\]()[\]_*#|\\/=~^]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?'"-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .replace(/[,;:\s-]+$/g, '');
}

function cleanTranscriptForIntent(transcript: string): string {
  return cleanAcknowledgementSpeech(transcript)
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey\s+)?clicky[\s,.:;-]+/i, '')
    .replace(/^(?:please\s+)?(?:can you|could you|would you|will you)\s+/i, '')
    .replace(/^(?:please\s+)?(?:go and|go|do|start|begin)\s+/i, '')
    .trim()
    .replace(/[.?!]+$/g, '');
}

function hasUsableTask(task: string): boolean {
  return /[\p{L}\p{N}]/u.test(task);
}
