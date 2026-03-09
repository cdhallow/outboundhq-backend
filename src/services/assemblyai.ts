import { AssemblyAI } from 'assemblyai';
import { createLogger } from '../utils/logger';

const logger = createLogger('AssemblyAIService');

// ─────────────────────────────────────────────
// Lazy-initialised client (same pattern as Twilio service)
// ─────────────────────────────────────────────

let _client: AssemblyAI | null = null;

function getClient(): AssemblyAI {
  if (_client) return _client;

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error('ASSEMBLYAI_API_KEY environment variable is not set');
  }

  _client = new AssemblyAI({ apiKey });
  return _client;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  confidence: number;
  words: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: string | null;
  }>;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
  }> | null;
}

// ─────────────────────────────────────────────
// Transcription
// ─────────────────────────────────────────────

/**
 * Submit a recording URL to AssemblyAI and wait for the transcript.
 * Uses speaker diarization so you can tell the SDR from the contact apart.
 */
export async function transcribeRecording(audioUrl: string): Promise<TranscriptionResult> {
  logger.info(`Submitting recording for transcription: ${audioUrl}`);

  try {
    const transcript = await getClient().transcripts.transcribe({
      audio_url:      audioUrl,
      speaker_labels: true,   // diarize speakers (SDR vs. contact on dual-channel)
      punctuate:      true,
      format_text:    true,
    });

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${transcript.error ?? 'unknown'}`);
    }

    logger.info(`Transcription complete. Confidence: ${transcript.confidence}`);

    return {
      text:        transcript.text       ?? '',
      confidence:  transcript.confidence ?? 0,
      words:       transcript.words      ?? [],
      utterances:  transcript.utterances ?? null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Transcription failed: ${msg}`, err);
    throw err;
  }
}
