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
  const { callId, contactPhone, contactId, userId } = req.body as {
    callId?:      string;
    contactPhone?: string;
    contactId?:   string;
    userId?:      string;
  };

  if (!contactPhone) {
    res.status(400).json({ error: 'contactPhone is required' });
    return;
  }

  logger.info(`Initiating call → ${contactPhone}`);

  try {
    let resolvedCallId = callId;

    if (resolvedCallId) {
      // Caller supplied an existing callId — look it up
      const { data: existing } = await supabase
        .from('calls')
        .select('id, status')
        .eq('id', resolvedCallId)
        .maybeSingle();

      if (existing && ['in_progress', 'ringing'].includes(existing.status)) {
        res.status(409).json({ error: `Call is already ${existing.status}` });
        return;
      }

      // If not found (e.g. CallProvider passed a client-generated UUID), create it
      if (!existing) {
        const { data: created, error: createErr } = await supabase
          .from('calls')
          .insert({
            id:          resolvedCallId,
            contact_id:  contactId  ?? null,
            user_id:     userId     ?? null,
            status:      'ringing',
            to_number:   contactPhone,
            from_number: process.env.TWILIO_PHONE_NUMBER ?? null,
            started_at:  new Date().toISOString(),
            created_at:  new Date().toISOString(),
            updated_at:  new Date().toISOString(),
          })
          .select('id')
          .single();

        if (createErr || !created) {
          logger.error('Failed to create call record', createErr);
          res.status(500).json({ error: 'Failed to create call record' });
          return;
        }

        logger.info(`Created call record ${resolvedCallId} for ${contactPhone}`);
        res.status(200).json({ success: true, callId: resolvedCallId });
        return;
      }
    } else {
      // No callId provided — create a fresh record and return the new ID
      const { data: created, error: createErr } = await supabase
        .from('calls')
        .insert({
          contact_id:  contactId  ?? null,
          user_id:     userId     ?? null,
          status:      'ringing',
          to_number:   contactPhone,
          from_number: process.env.TWILIO_PHONE_NUMBER ?? null,
          started_at:  new Date().toISOString(),
          created_at:  new Date().toISOString(),
          updated_at:  new Date().toISOString(),
        })
        .select('id')
        .single();

      if (createErr || !created) {
        logger.error('Failed to create call record', createErr);
        res.status(500).json({ error: 'Failed to create call record' });
        return;
      }

      resolvedCallId = created.id;
      logger.info(`Created call record ${resolvedCallId} for ${contactPhone}`);
      res.status(200).json({ success: true, callId: resolvedCallId });
      return;
    }

    // Existing record found — stage it as ringing
    await supabase
      .from('calls')
      .update({
        status:      'ringing',
        to_number:   contactPhone,
        from_number: process.env.TWILIO_PHONE_NUMBER ?? null,
        started_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', resolvedCallId);

    logger.info(`Staged existing call record ${resolvedCallId} → ringing`);
    res.status(200).json({ success: true, callId: resolvedCallId });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to initiate call to ${contactPhone}`, error);
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
    logger.error('Voice webhook received with no To parameter — check browser SDK params');
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>No destination number was provided.</Say></Response>`);
    return;
  }

  const backendUrl  = ensureHttps((process.env.BACKEND_URL ?? '').replace(/\/$/, ''));
  const fromNumber  = process.env.TWILIO_PHONE_NUMBER ?? '';

  // Normalise to E.164 as a backend safety net (frontend should send it already formatted)
  const destination = toE164(To);

  // Update our DB record with the real Twilio CallSid now that it exists
  if (callId && CallSid) {
    // Save twilio_call_sid separately from status — status has a strict DB enum
    // and will be updated by the Twilio status webhook as the call progresses.
    const { error: updateErr } = await supabase
      .from('calls')
      .update({
        twilio_call_sid: CallSid,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', callId);
    if (updateErr) logger.error('Failed to update call SID in voice webhook', updateErr);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${fromNumber}"
        record="record-from-answer"
        recordingChannels="2"
        recordingStatusCallback="${backendUrl}/webhooks/twilio/recording"
        recordingStatusCallbackMethod="POST">
    <Number statusCallback="${backendUrl}/webhooks/twilio/status"
            statusCallbackMethod="POST"
            statusCallbackEvent="initiated ringing answered completed">${destination}</Number>
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
// GET /api/calls/contact/:contactId
// Full call history for a contact — used by Contact detail view.
// ─────────────────────────────────────────────

router.get('/contact/:contactId', async (req: Request, res: Response): Promise<void> => {
  const { contactId } = req.params;

  try {
    const { data: calls, error } = await supabase
      .from('calls')
      .select(`
        id,
        status,
        outcome,
        duration_seconds,
        started_at,
        ended_at,
        from_number,
        to_number,
        recording_url,
        has_recording:  recording_url,
        has_transcript: transcript,
        ai_summary,
        user_id,
        created_at
      `)
      .eq('contact_id', contactId)
      .order('started_at', { ascending: false });

    if (error) throw error;

    const result = (calls ?? []).map((c) => ({
      ...c,
      has_recording:  c.has_recording  !== null,
      has_transcript: c.has_transcript !== null,
    }));

    res.status(200).json({ calls: result });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to fetch call history for contact ${contactId}`, error);
    res.status(500).json({ error: 'Failed to fetch call history', details: error.message });
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

/** Normalise any phone number to E.164 format required by Twilio. */
function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
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
