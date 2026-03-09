import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger';

const logger = createLogger('ClaudeService');

// ─────────────────────────────────────────────
// Lazy-initialised client
// ─────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  _client = new Anthropic({ apiKey });
  return _client;
}

const MODEL = 'claude-sonnet-4-20250514';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CallSummary {
  summary:       string;        // 2-3 sentence overview
  keyPoints:     string[];      // Topics covered
  nextSteps:     string[];      // Action items
  coachingTips:  string[];      // SDR coaching tips
}

// ─────────────────────────────────────────────
// Summary generation
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert sales coach analysing outbound sales call transcripts.
Your output must always be valid JSON — no markdown fences, no extra commentary, just the JSON object.`;

const USER_PROMPT_TEMPLATE = (transcript: string) => `Analyse this sales call transcript and provide structured feedback.

TRANSCRIPT:
${transcript}

Respond with a JSON object using exactly these keys:
{
  "summary":      "<2–3 sentence overview of what happened on the call>",
  "keyPoints":    ["<topic or point discussed>", ...],
  "nextSteps":    ["<concrete action item>", ...],
  "coachingTips": ["<specific, actionable coaching tip for the SDR>", "<tip 2>", "<tip 3>"]
}

Rules:
- keyPoints: 3–6 bullet points covering the main topics
- nextSteps: specific follow-up actions with owners where possible
- coachingTips: 2–3 tips grounded in what actually happened, not generic advice
- If the transcript is too short or unclear, still return the JSON with best-effort values`;

/**
 * Send a call transcript to Claude and get a structured summary back.
 * Throws if the API call fails; caller is responsible for graceful degradation.
 */
export async function generateCallSummary(transcript: string): Promise<CallSummary> {
  if (!transcript.trim()) {
    throw new Error('Cannot summarise an empty transcript');
  }

  logger.info(`Generating call summary (transcript length: ${transcript.length} chars)`);

  const message = await getClient().messages.create({
    model:      MODEL,
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: USER_PROMPT_TEMPLATE(transcript) },
    ],
  });

  // Extract text from the first content block
  const firstBlock = message.content[0];
  if (!firstBlock || firstBlock.type !== 'text') {
    throw new Error('Claude returned an unexpected response format');
  }

  const raw = firstBlock.text.trim();
  logger.debug('Raw Claude response', { raw });

  // Strip markdown code fences if Claude included them despite instructions
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: CallSummary;
  try {
    parsed = JSON.parse(jsonText) as CallSummary;
  } catch {
    logger.error('Claude response was not valid JSON', { raw });
    throw new Error(`Claude returned non-JSON content: ${raw.slice(0, 200)}`);
  }

  // Normalise to guarantee arrays (defensive against model drift)
  return {
    summary:      parsed.summary      ?? '',
    keyPoints:    Array.isArray(parsed.keyPoints)    ? parsed.keyPoints    : [],
    nextSteps:    Array.isArray(parsed.nextSteps)    ? parsed.nextSteps    : [],
    coachingTips: Array.isArray(parsed.coachingTips) ? parsed.coachingTips : [],
  };
}
