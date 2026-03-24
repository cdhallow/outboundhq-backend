/**
 * scripts/setup-twilio.ts
 *
 * Run once to automatically provision:
 *   1. A Twilio API Key pair  (TWILIO_API_KEY + TWILIO_API_SECRET)
 *   2. A TwiML App            (TWILIO_TWIML_APP_SID)
 *
 * Usage:
 *   npx ts-node scripts/setup-twilio.ts
 *
 * Prerequisites:
 *   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and BACKEND_URL must be in your .env
 *
 * The script prints the three env var lines to copy into your .env (and Railway).
 * It is fully idempotent: re-running it creates new resources each time, so only
 * run it once (or delete the old ones in the Twilio Console first).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const backendUrl = process.env.BACKEND_URL;

if (!accountSid || !authToken) {
  console.error('❌  TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
  process.exit(1);
}

if (!backendUrl) {
  console.error('❌  BACKEND_URL must be set in .env (e.g. https://your-app.railway.app)');
  process.exit(1);
}

const voiceUrl = `${backendUrl.replace(/\/$/, '')}/api/calls/voice`;

async function main() {
  const client = twilio(accountSid!, authToken!);

  console.log('\n🔧  OutboundHQ — Twilio auto-setup\n');
  console.log(`   Account SID : ${accountSid}`);
  console.log(`   Voice URL   : ${voiceUrl}\n`);

  // ── 1. Create API Key ──────────────────────────────────────────────────────
  console.log('Creating API Key...');
  const apiKey = await client.newKeys.create({ friendlyName: 'OutboundHQ Voice SDK' });
  console.log(`  ✅  API Key created: ${apiKey.sid}\n`);

  // ── 2. Create TwiML App ────────────────────────────────────────────────────
  console.log('Creating TwiML App...');
  const twimlApp = await client.applications.create({
    friendlyName:        'OutboundHQ Dialer',
    voiceUrl:            voiceUrl,
    voiceMethod:         'POST',
    statusCallback:      `${backendUrl!.replace(/\/$/, '')}/webhooks/twilio/status`,
    statusCallbackMethod: 'POST',
  });
  console.log(`  ✅  TwiML App created: ${twimlApp.sid}\n`);

  // ── 3. Print the env vars ──────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('✅  Done! Add these to your .env and Railway environment:\n');
  console.log(`TWILIO_API_KEY=${apiKey.sid}`);
  console.log(`TWILIO_API_SECRET=${apiKey.secret}`);
  console.log(`TWILIO_TWIML_APP_SID=${twimlApp.sid}`);
  console.log('─'.repeat(60));
  console.log('\n⚠️   TWILIO_API_SECRET is only shown once — copy it now!\n');
}

main().catch(err => {
  console.error('❌  Setup failed:', err.message);
  process.exit(1);
});
