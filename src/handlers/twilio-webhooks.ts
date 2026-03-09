import { Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { transcribeRecording } from '../services/assemblyai';
import { generateCallSummary } from '../services/claude';
import { getRecordingUrl } from '../services/twilio';
import { createLogger } from '../utils/logger';

const logger = createLogger('TwilioWebhook');

// ─────────────────────────────────────────────
// Twilio call status → OutboundHQ status mapping
// ─────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  initiated:   'ringing',
  ringing:     'ringing',
  'in-progress': 'in_progress',
  answered:    'in_progress',
  completed:   'completed',
  busy:        'busy',
  'no-answer': 'no_answer',
  failed:      'failed',
  canceled:    'failed',
};

// ─────────────────────────────────────────────
// POST /webhooks/twilio/status
// Twilio fires this at every status transition.
// ─────────────────────────────────────────────

export async function handleCallStatus(req: Request, res: Response): Promise<void> {
  try {
    const {
      CallSid,
      CallStatus,
      CallDuration,
    } = req.body as {
      CallSid: string;
      CallStatus: string;
      CallDuration?: string;
    };

    logger.info(`Call status: ${CallSid} → ${CallStatus}`);

    // Look up our call record by Twilio SID
    const { data: call } = await supabase
      .from('calls')
      .select('id')
      .eq('twilio_call_sid', CallSid)
      .maybeSingle();

    if (!call) {
      logger.warn(`No call record found for Twilio SID: ${CallSid}`);
      res.status(200).send('OK');
      return;
    }

    const status  = STATUS_MAP[CallStatus] ?? CallStatus;
    const updates: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (CallStatus === 'completed') {
      updates['ended_at'] = new Date().toISOString();
      if (CallDuration) {
        updates['duration_seconds'] = parseInt(CallDuration, 10);
      }
    }

    await supabase
      .from('calls')
      .update(updates)
      .eq('id', call.id);

    logger.info(`Call ${call.id} updated to status "${status}"`);
    res.status(200).send('OK');
  } catch (err: unknown) {
    logger.error('Error handling call status webhook', err);
    // Return 200 to prevent Twilio retry storms
    res.status(200).send('OK');
  }
}

// ─────────────────────────────────────────────
// POST /webhooks/twilio/recording
// Twilio fires this when a recording is ready.
// Kicks off async transcription — does not block the response.
// ─────────────────────────────────────────────

export async function handleRecording(req: Request, res: Response): Promise<void> {
  try {
    const {
      CallSid,
      RecordingSid,
      RecordingDuration,
    } = req.body as {
      CallSid: string;
      RecordingSid: string;
      RecordingDuration?: string;
    };

    logger.info(`Recording ready: ${RecordingSid} for call ${CallSid}`);

    // Find call record
    const { data: call } = await supabase
      .from('calls')
      .select('id')
      .eq('twilio_call_sid', CallSid)
      .maybeSingle();

    if (!call) {
      logger.warn(`No call record found for Twilio SID: ${CallSid}`);
      res.status(200).send('OK');
      return;
    }

    // Build the public MP3 URL
    const recordingUrl = await getRecordingUrl(RecordingSid);

    // Persist recording metadata immediately
    await supabase
      .from('calls')
      .update({
        twilio_recording_sid: RecordingSid,
        recording_url:        recordingUrl,
        recording_duration:   RecordingDuration ? parseInt(RecordingDuration, 10) : null,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', call.id);

    logger.info(`Recording URL saved for call ${call.id}`);

    // Fire-and-forget transcription — don't make Twilio wait
    transcribeCallRecording(call.id, recordingUrl).catch((err: unknown) => {
      logger.error(`Background transcription failed for call ${call.id}`, err);
    });

    res.status(200).send('OK');
  } catch (err: unknown) {
    logger.error('Error handling recording webhook', err);
    res.status(200).send('OK');
  }
}

// ─────────────────────────────────────────────
// Internal: transcribe + save (async, not on the request path)
// ─────────────────────────────────────────────

async function transcribeCallRecording(callId: string, audioUrl: string): Promise<void> {
  logger.info(`Starting transcription for call ${callId}`);

  try {
    const result = await transcribeRecording(audioUrl);

    await supabase
      .from('calls')
      .update({
        transcript:  result.text,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', callId);

    logger.info(
      `Transcription saved for call ${callId} ` +
      `(${result.text.length} chars, confidence ${(result.confidence * 100).toFixed(1)}%)`
    );

    // ── AI summary (fault-isolated: a Claude failure must not undo the transcript) ──
    await generateAndSaveCallSummary(callId, result.text);
  } catch (err: unknown) {
    logger.error(`Transcription failed for call ${callId}`, err);

    // Mark transcript field with error note so the UI can surface it
    const { error: updateErr } = await supabase
      .from('calls')
      .update({
        transcript:  '[Transcription failed — check server logs]',
        updated_at:  new Date().toISOString(),
      })
      .eq('id', callId);
    if (updateErr) logger.error('Failed to write transcription error marker', updateErr);
  }
}

// ─────────────────────────────────────────────
// Internal: generate AI summary with Claude + save (async, fault-isolated)
// Runs after transcription. Any error here is logged but never propagates
// upward — the transcript is already safely persisted by this point.
// ─────────────────────────────────────────────

async function generateAndSaveCallSummary(callId: string, transcript: string): Promise<void> {
  logger.info(`Generating AI summary for call ${callId}`);

  try {
    const summary = await generateCallSummary(transcript);

    const { error } = await supabase
      .from('calls')
      .update({
        ai_summary:  JSON.stringify(summary),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', callId);

    if (error) throw error;

    logger.info(
      `AI summary saved for call ${callId} — ` +
      `${summary.keyPoints.length} key points, ${summary.nextSteps.length} next steps`
    );
  } catch (err: unknown) {
    // Log but do NOT rethrow — caller has already saved the transcript successfully
    logger.error(`AI summary generation failed for call ${callId}`, err);
  }
}
