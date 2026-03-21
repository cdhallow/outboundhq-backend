import { Router, Request, Response } from 'express';
import { endCall, getCallDetails, generateAccessToken } from '../services/twilio';
import { supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('CallsRoute');

// ─────────────────────────────────────────────
// GET /api/calls/token
// Returns a short-lived Twilio Access Token so the browser SDK can connect.
// The frontend should call this once on mount and refresh before expiry (1 hr).
// ─────────────────────────────────────────────

router.get('/token', (req: Request, res: Response): void => {
  const { userId } = req.query as { userId?: string };

  if (!userId) {
    res.status(400).json({ error: 'userId query param is required' });
    return;
  }

  try {
    const token = generateAccessToken(userId);
    res.status(200).json({ token, identity: userId });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Failed to generate access token', error);
    res.status(500).json({ error: 'Failed to generate token', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/calls/initiate
// SDR clicks "Call" → prepares the DB record and returns callId.
// The browser SDK then calls device.connect({ params: { To, callId } })
// which triggers POST /api/calls/voice below to place the actual call.
// ─────────────────────────────────────────────

router.post('/initiate', async (req: Request, res: Response): Promise<void> => {
  const { callId, contactPhone } = req.body as {
    callId?: string;
    contactPhone?: string;
  };

  if (!callId || !contactPhone) {
    res.status(400).json({ error: 'callId and contactPhone are required' });
    return;
  }

  logger.info(`Preparing call record ${callId} → ${contactPhone}`);

  try {
    const { data: call, error: fetchError } = await supabase
      .from('calls')
      .select('id, status')
      .eq('id', callId)
      .single();

    if (fetchError || !call) {
      res.status(404).json({ error: 'Call record not found' });
      return;
    }

    if (['in_progress', 'ringing'].includes(call.status)) {
      res.status(409).json({ error: `Call is already ${call.status}` });
      return;
    }

    // Stage the record — twilio_call_sid is set by /voice when Twilio connects
    await supabase
      .from('calls')
      .update({
        status:      'ringing',
        to_number:   contactPhone,
        from_number: process.env.TWILIO_PHONE_NUMBER ?? null,
        started_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', callId);

    // Return callId — the browser SDK uses this when calling device.connect()
    res.status(200).json({ success: true, callId });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to prepare call ${callId}`, error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/calls/voice
// TwiML App webhook — Twilio calls this when the browser SDK connects.
// Returns TwiML that dials the contact and enables recording.
// Configure in Twilio Console → TwiML Apps → Voice URL.
// ─────────────────────────────────────────────

router.post('/voice', async (req: Request, res: Response): Promise<void> => {
  const { CallSid, To, callId } = req.body as {
    CallSid?: string;
    To?: string;
    callId?: string;
  };

  logger.info(`Voice webhook: CallSid=${CallSid} To=${To} callId=${callId}`);

  if (!To) {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>No destination number was provided.</Say></Response>`);
    return;
  }

  const backendUrl  = ensureHttps((process.env.BACKEND_URL ?? '').replace(/\/$/, ''));
  const fromNumber  = process.env.TWILIO_PHONE_NUMBER ?? '';

  // Update our DB record with the real Twilio CallSid now that it exists
  if (callId && CallSid) {
    const { error: updateErr } = await supabase
      .from('calls')
      .update({
        twilio_call_sid: CallSid,
        status:          'in_progress',
        updated_at:      new Date().toISOString(),
      })
      .eq('id', callId);
    if (updateErr) logger.error('Failed to update call SID in voice webhook', updateErr);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${fromNumber}"
        record="record-from-answer"
        recordingStatusCallback="${backendUrl}/webhooks/twilio/recording"
        recordingStatusCallbackMethod="POST">
    <Number statusCallback="${backendUrl}/webhooks/twilio/status"
            statusCallbackMethod="POST"
            statusCallbackEvent="initiated ringing answered completed">${To}</Number>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ─────────────────────────────────────────────
// POST /api/calls/:id/end
// Force-end an in-progress call.
// ─────────────────────────────────────────────

router.post('/:id/end', async (req: Request, res: Response): Promise<void> => {
  const { id: callId } = req.params;

  logger.info(`End call request for ${callId}`);

  try {
    const { data: call, error: fetchError } = await supabase
      .from('calls')
      .select('twilio_call_sid, status')
      .eq('id', callId)
      .single();

    if (fetchError || !call) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    if (!call.twilio_call_sid) {
      res.status(400).json({ error: 'Call has no associated Twilio SID' });
      return;
    }

    if (call.status === 'completed') {
      res.status(409).json({ error: 'Call is already completed' });
      return;
    }

    await endCall(call.twilio_call_sid);

    await supabase
      .from('calls')
      .update({
        status:     'completed',
        ended_at:   new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', callId);

    logger.info(`Call ${callId} ended`);

    res.status(200).json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to end call ${callId}`, error);
    res.status(500).json({ error: 'Failed to end call', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/calls/:id/status
// Poll current call state (merges DB record with live Twilio data).
// ─────────────────────────────────────────────

router.get('/:id/status', async (req: Request, res: Response): Promise<void> => {
  const { id: callId } = req.params;

  try {
    const { data: call, error: fetchError } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (fetchError || !call) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    // If there's a live Twilio SID, enrich with real-time data
    let twilioDetails = null;
    if (call.twilio_call_sid && ['ringing', 'in_progress'].includes(call.status)) {
      try {
        twilioDetails = await getCallDetails(call.twilio_call_sid);
      } catch {
        // Non-fatal: Twilio might not have the call yet
      }
    }

    res.status(200).json({ call, twilio: twilioDetails });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to get status for call ${callId}`, error);
    res.status(500).json({ error: 'Failed to get call status', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/calls/twiml
// Twilio fetches this when the contact answers.
// Plays a brief message, then bridges the SDR into the call.
//
// For SDR bridging, pass `sdrPhone` when the call is initiated (future) or
// configure a Twilio Client identity.  Today: just record and greet.
// ─────────────────────────────────────────────

function ensureHttps(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `https://${url}`;
}

router.get('/twiml', (req: Request, res: Response): void => {
  const { callId, sdrPhone } = req.query as { callId?: string; sdrPhone?: string };

  logger.debug(`TwiML requested for callId=${callId}`);

  const backendUrl = ensureHttps((process.env.BACKEND_URL ?? '').replace(/\/$/, ''));

  let dialVerb = '';
  if (sdrPhone) {
    // Bridge the contact to the SDR's phone number
    dialVerb = `<Dial record="record-from-answer" recordingStatusCallback="${backendUrl}/webhooks/twilio/recording">${sdrPhone}</Dial>`;
  } else {
    // Fallback: hold the contact until the SDR joins via Twilio Client
    dialVerb = `<Dial record="record-from-answer" recordingStatusCallback="${backendUrl}/webhooks/twilio/recording">
      <Conference waitUrl="https://twilio.com/comms-library/twiml/hold-music"
                  endConferenceOnExit="true">
        OutboundHQ-${callId ?? 'call'}
      </Conference>
    </Dial>`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting your call now. Please hold.</Say>
  ${dialVerb}
</Response>`;

  res.type('text/xml').send(twiml);
});

// ─────────────────────────────────────────────
// PATCH /api/calls/:id/notes
// Let the SDR save call notes / outcome after hanging up.
// ─────────────────────────────────────────────

router.patch('/:id/notes', async (req: Request, res: Response): Promise<void> => {
  const { id: callId } = req.params;
  const { notes } = req.body as { notes?: string };

  if (!notes) {
    res.status(400).json({ error: 'notes field is required' });
    return;
  }

  try {
    const { error } = await supabase
      .from('calls')
      .update({ notes, updated_at: new Date().toISOString() })
      .eq('id', callId);

    if (error) throw error;

    res.status(200).json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to save notes for call ${callId}`, error);
    res.status(500).json({ error: 'Failed to save notes', details: error.message });
  }
});

export default router;
