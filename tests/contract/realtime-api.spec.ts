import { describe, expect, it } from 'vitest';

async function callRealtimeApi(model: string): Promise<{ status: number; body: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { status: 401, body: 'OPENAI_API_KEY not set' };
  }

  const form = new FormData();
  form.set('sdp', 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n');

  // Minimal session config to trigger model validation
  form.set('session', new Blob([JSON.stringify({
    type: 'realtime',
    model,
    audio: {
      input: { transcription: { model: 'gpt-4o-mini-transcribe' } }
    }
  })], { type: 'application/json' }));

  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      body: form
    }
  );

  const body = await response.text();
  return { status: response.status, body };
}

describe('Realtime API contract', () => {
  it('gpt-realtime-2 returns invalid_offer for dummy SDP', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('OPENAI_API_KEY not set — skipping realtime contract test');
      return;
    }

    const result = await callRealtimeApi('gpt-realtime-2');

    // Expected: OpenAI rejects the dummy SDP with an error about the offer,
    // NOT a model-not-found or parameter error.
    const errorMessages = [
      'invalid_offer',
      'invalid_sdp',
      'sdp',
      'session',
      'offer'
    ];

    const rejectionErrors = [
      'missing_model',
      'invalid_model',
      'unknown_parameter',
      'model_not_found',
      'unsupported_model'
    ];

    const hasExpectedError = errorMessages.some((msg) =>
      result.body.toLowerCase().includes(msg)
    );

    const hasRejectionError = rejectionErrors.some((msg) =>
      result.body.toLowerCase().includes(msg)
    );

    // The API should return 400 Bad Request with an offer-related error
    expect(result.status).toBe(400);

    if (hasRejectionError) {
      throw new Error(
        `gpt-realtime-2 contract violation: got rejection error "${result.body}" ` +
        `instead of offer/sdp validation error. The model endpoint may have changed.`
      );
    }

    expect(hasExpectedError).toBe(true);
  }, 15_000);

  it('rejects unknown model with model-related error', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('OPENAI_API_KEY not set — skipping realtime contract test');
      return;
    }

    const result = await callRealtimeApi('gpt-fake-model-999');

    const modelErrors = [
      'invalid_model',
      'unknown_model',
      'model_not_found',
      'unsupported'
    ];

    const hasModelError = modelErrors.some((msg) =>
      result.body.toLowerCase().includes(msg)
    );

    // Unknown model should be rejected with a model-related error
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(hasModelError).toBe(true);
  }, 15_000);
});
