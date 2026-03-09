import { Router, Request, Response } from 'express';
import { initiateCall, endCall, getCallDetails } from '../services/twilio';
import { supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('CallsRoute');

// ─────────────────────────────────────────────
// POST /api/calls/initiate
// SDR clicks "Call" → backend spins up a Twilio call, updates the DB record.
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

  logger.info(`Initiate call ${callId} → ${contactPhone}`);

  try {
    // 1. Verify the call record exists
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

    // 2. Kick off the Twilio call
    const twilioCallSid = await initiateCall({ to: contactPhone, callId });

    // 3. Persist the SID + initial state
    await supabase
      .from('calls')
      .update({
        twilio_call_sid: twilioCallSid,
        status:          'ringing',
        to_number:       contactPhone,
        from_number:     process.env.TWILIO_PHONE_NUMBER ?? null,
        started_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      .eq('id', callId);

    logger.info(`Call ${callId} initiated → Twilio SID ${twilioCallSid}`);

    res.status(200).json({ success: true, twilioCallSid });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to initiate call ${callId}`, error);
    res.status(500).json({ error: 'Failed to initiate call', details: error.message });
  }
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

router.get('/twiml', (req: Request, res: Response): void => {
  const { callId, sdrPhone } = req.query as { callId?: string; sdrPhone?: string };

  logger.debug(`TwiML requested for callId=${callId}`);

  let dialVerb = '';
  if (sdrPhone) {
    // Bridge the contact to the SDR's phone number
    dialVerb = `<Dial record="record-from-answer" recordingStatusCallback="${
      process.env.BACKEND_URL ?? ''
    }/webhooks/twilio/recording">${sdrPhone}</Dial>`;
  } else {
    // Fallback: hold the contact until the SDR joins via Twilio Client
    dialVerb = `<Dial record="record-from-answer" recordingStatusCallback="${
      process.env.BACKEND_URL ?? ''
    }/webhooks/twilio/recording">
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
