import twilio, { Twilio } from 'twilio';
import { createLogger } from '../utils/logger';

const logger = createLogger('TwilioService');

// ─────────────────────────────────────────────
// Lazy-initialised client
// The server can start without Twilio credentials (e.g. for Smartlead-only
// development), but will throw clearly the first time a calling function runs.
// ─────────────────────────────────────────────

let _client: Twilio | null = null;

function getClient(): Twilio {
  if (_client) return _client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error(
      'Missing Twilio credentials: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set'
    );
  }

  _client = twilio(accountSid, authToken);
  return _client;
}

function getTwilioPhoneNumber(): string {
  const n = process.env.TWILIO_PHONE_NUMBER;
  if (!n) throw new Error('TWILIO_PHONE_NUMBER environment variable is not set');
  return n;
}

function getBackendUrl(): string {
  const u = process.env.BACKEND_URL;
  if (!u) throw new Error('BACKEND_URL environment variable is not set');
  return u.replace(/\/$/, ''); // strip trailing slash
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface InitiateCallParams {
  to: string;       // Contact's phone number  e.g. "+14155552671"
  callId: string;   // Our database call ID (passed through TwiML URL)
}

export interface CallDetails {
  status: string;
  duration: string | null;
  startTime: Date | null;
  endTime: Date | null;
}

// ─────────────────────────────────────────────
// Call management
// ─────────────────────────────────────────────

/**
 * Initiate an outbound call from the Twilio number to `to`.
 * Returns the Twilio CallSid.
 */
export async function initiateCall(params: InitiateCallParams): Promise<string> {
  const client      = getClient();
  const backendUrl  = getBackendUrl();
  const fromNumber  = getTwilioPhoneNumber();

  logger.info(`Initiating call to ${params.to} for callId ${params.callId}`);

  try {
    const call = await client.calls.create({
      to:   params.to,
      from: fromNumber,

      // TwiML instructions executed when the contact picks up
      url: `${backendUrl}/api/calls/twiml?callId=${encodeURIComponent(params.callId)}`,

      // Status update webhook (initiated → ringing → in-progress → completed)
      statusCallback:       `${backendUrl}/webhooks/twilio/status`,
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',

      // Recording
      record:                          true,
      recordingStatusCallback:         `${backendUrl}/webhooks/twilio/recording`,
      recordingStatusCallbackMethod:   'POST',
      recordingChannels:               'dual', // separate channel per party
    });

    logger.info(`Twilio call created with SID: ${call.sid}`);
    return call.sid;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Call initiation failed: ${msg}`, err);
    throw err;
  }
}

/**
 * Fetch live call status / duration from Twilio.
 */
export async function getCallDetails(callSid: string): Promise<CallDetails> {
  try {
    const call = await getClient().calls(callSid).fetch();
    return {
      status:    call.status,
      duration:  call.duration ?? null,
      startTime: call.startTime ?? null,
      endTime:   call.endTime   ?? null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to fetch call details for ${callSid}: ${msg}`);
    throw err;
  }
}

/**
 * Build the public MP3 URL for a Twilio recording.
 */
export async function getRecordingUrl(recordingSid: string): Promise<string> {
  try {
    const recording = await getClient().recordings(recordingSid).fetch();
    // recording.uri  →  "/2010-04-01/Accounts/.../Recordings/RE....json"
    const mp3Path = recording.uri.replace('.json', '.mp3');
    return `https://api.twilio.com${mp3Path}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to fetch recording ${recordingSid}: ${msg}`);
    throw err;
  }
}

/**
 * Force-complete an in-progress call.
 */
export async function endCall(callSid: string): Promise<void> {
  try {
    await getClient().calls(callSid).update({ status: 'completed' });
    logger.info(`Call ${callSid} ended`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to end call ${callSid}: ${msg}`);
    throw err;
  }
}
