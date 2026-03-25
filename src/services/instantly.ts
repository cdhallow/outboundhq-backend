import axios, { AxiosInstance, AxiosError } from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger('InstantlyService');

const BASE_URL = 'https://api.instantly.ai/api/v2';
const LEAD_BATCH_SIZE = 400; // Instantly max per request

// ─────────────────────────────────────────────
// Lazy-initialised HTTP client
// ─────────────────────────────────────────────

let _client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (_client) return _client;

  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error('INSTANTLY_API_KEY environment variable is not set');
  }

  _client = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
  });

  return _client;
}

function handleAxiosError(error: unknown, context: string): never {
  if (error instanceof AxiosError) {
    const status  = error.response?.status;
    const message = error.response?.data?.message ?? error.response?.data?.error ?? error.message;
    logger.error(`${context} failed [${status}]: ${message}`, error.response?.data);
    throw new Error(`Instantly API error in ${context}: ${message} (HTTP ${status})`);
  }
  throw error;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SequenceStepInput {
  step_number: number;
  subject:     string;
  body:        string;
  delay_days:  number;
}

export interface CampaignInput {
  id:              string;         // OutboundHQ sequence ID (used for deduplication label)
  name:            string;
  steps:           SequenceStepInput[];
  fromName:        string;         // SDR's display name  e.g. "Jane Smith"
  replyTo:         string;         // SDR's email address
  emailAccountId?: string | null;  // Instantly inbox — optional at activation, set at enrollment
}

export interface InstantlyEmailAccount {
  id:             string;
  email:          string;
  firstName?:     string;
  lastName?:      string;
  status?:        string;
}

export interface LeadInput {
  email:           string;
  first_name?:     string;
  last_name?:      string;
  company_name?:   string;
  personalization?: string; // AI-generated custom first line (if present)
}

export interface CampaignAnalytics {
  sent:    number;
  opened:  number;
  clicked: number;
  replied: number;
}

// ─────────────────────────────────────────────
// Campaign management
// ─────────────────────────────────────────────

/**
 * Create an Instantly campaign from an OutboundHQ sequence.
 * Returns the Instantly campaign ID string.
 */
export async function createCampaign(input: CampaignInput): Promise<string> {
  const client = getClient();

  logger.info(`Creating Instantly campaign for sequence "${input.name}" (${input.id})`);

  // 1. Create the campaign shell with the sending inbox attached
  let campaignId: string;
  try {
    const payload: Record<string, unknown> = {
      name:      input.name,
      from_name: input.fromName,
      reply_to:  input.replyTo,
      // Required by Instantly V2 — full day names per spec, Mon-Fri 8am-5pm ET
      campaign_schedule: {
        schedules: [
          {
            name: 'Default',
            timing: { from: '08:00', to: '17:00' },
            days: {
              sunday:    false,
              monday:    true,
              tuesday:   true,
              wednesday: true,
              thursday:  true,
              friday:    true,
              saturday:  false,
            },
            timezone: 'America/New_York',
          },
        ],
      },
    };
    if (input.emailAccountId) {
      payload['email_account_ids'] = [input.emailAccountId];
    }
    const { data } = await client.post('/campaigns', payload);
    campaignId = String(data.id ?? data.campaign_id ?? '');
    if (!campaignId) throw new Error('Instantly did not return a campaign ID');
    logger.info(`Instantly campaign created: ${campaignId} (inbox: ${input.emailAccountId})`);
  } catch (err) {
    handleAxiosError(err, 'createCampaign');
  }

  // 2. Add sequence steps — delay is in DAYS per V2 spec (not hours)
  const sequences = [
    {
      steps: input.steps.map((step) => ({
        type:  'email',
        delay: step.delay_days,
        variants: [
          {
            subject: step.subject,
            body:    step.body,
          },
        ],
      })),
    },
  ];

  try {
    await client.post(`/campaigns/${campaignId!}/sequences`, { sequences });
    logger.info(`Added ${input.steps.length} step(s) to Instantly campaign ${campaignId}`);
  } catch (err) {
    handleAxiosError(err, 'addSequenceSteps');
  }

  return campaignId!;
}

/**
 * Add leads to an Instantly campaign in batches of up to 400.
 * Handles batching automatically.
 */
export async function bulkAddLeadsToCampaign(
  campaignId: string,
  leads: LeadInput[]
): Promise<void> {
  const client = getClient();

  logger.info(`Adding ${leads.length} lead(s) to Instantly campaign ${campaignId}`);

  // V2 endpoint: POST /leads with campaign_id in body, `leads` array (not `lead_list`)
  for (let i = 0; i < leads.length; i += LEAD_BATCH_SIZE) {
    const batch = leads.slice(i, i + LEAD_BATCH_SIZE);

    try {
      await client.post('/leads', {
        campaign_id:         campaignId,
        skip_if_in_campaign: true,
        leads: batch.map((l) => ({
          email:           l.email,
          first_name:      l.first_name      ?? '',
          last_name:       l.last_name       ?? '',
          company_name:    l.company_name    ?? '',
          personalization: l.personalization ?? '',
        })),
      });

      logger.info(
        `Batch ${Math.floor(i / LEAD_BATCH_SIZE) + 1}: ` +
        `${batch.length} lead(s) added to campaign ${campaignId}`
      );
    } catch (err) {
      handleAxiosError(err, `bulkAddLeads (batch ${Math.floor(i / LEAD_BATCH_SIZE) + 1})`);
    }
  }
}

/**
 * Pause an Instantly campaign.
 */
export async function pauseCampaign(campaignId: string): Promise<void> {
  const client = getClient();
  logger.info(`Pausing Instantly campaign ${campaignId}`);
  try {
    await client.post(`/campaigns/${campaignId}/pause`);
  } catch (err) {
    handleAxiosError(err, 'pauseCampaign');
  }
}

/**
 * Resume (activate) an Instantly campaign.
 */
export async function resumeCampaign(campaignId: string): Promise<void> {
  const client = getClient();
  logger.info(`Resuming Instantly campaign ${campaignId}`);
  try {
    await client.post(`/campaigns/${campaignId}/activate`);
  } catch (err) {
    handleAxiosError(err, 'resumeCampaign');
  }
}

/**
 * Attach a sending inbox to an existing campaign.
 * Called at enrollment time when the SDR picks their inbox.
 */
export async function attachEmailAccount(campaignId: string, emailAccountId: string): Promise<void> {
  const client = getClient();
  logger.info(`Attaching inbox ${emailAccountId} to campaign ${campaignId}`);
  try {
    // V2: update campaign with email_account_ids via PATCH
    await client.patch(`/campaigns/${campaignId}`, {
      email_account_ids: [emailAccountId],
    });
  } catch (err) {
    handleAxiosError(err, 'attachEmailAccount');
  }
}

/**
 * List all email accounts (sending inboxes) connected to this Instantly workspace.
 * Used by the SDR settings screen in Lovable to pick their sending inbox.
 */
export async function listEmailAccounts(): Promise<InstantlyEmailAccount[]> {
  const client = getClient();
  logger.info('Fetching Instantly email accounts');
  try {
    const { data } = await client.get('/accounts', {
      params: { limit: 100 },
    });
    // V2 returns { items: [...] } or a plain array
    const accounts: Array<Record<string, unknown>> = Array.isArray(data) ? data : (data?.items ?? []);
    return accounts.map((a) => ({
      id:        String(a.id ?? a.email_account_id ?? ''),
      email:     String(a.email ?? ''),
      firstName: a.first_name ? String(a.first_name) : undefined,
      lastName:  a.last_name  ? String(a.last_name)  : undefined,
      status:    a.status     ? String(a.status)     : undefined,
    }));
  } catch (err) {
    handleAxiosError(err, 'listEmailAccounts');
  }
}

/**
 * Remove a lead from an Instantly campaign by email.
 * Used when unenrolling a contact from a sequence.
 */
export async function removeLead(campaignId: string, email: string): Promise<void> {
  const client = getClient();
  logger.info(`Removing lead ${email} from Instantly campaign ${campaignId}`);
  try {
    // V2: DELETE /leads with campaign_id + email in body
    await client.delete('/leads', {
      data: { campaign_id: campaignId, email },
    });
  } catch (err) {
    // Non-fatal if the lead doesn't exist in Instantly (e.g. never added)
    if (err instanceof AxiosError && err.response?.status === 404) {
      logger.warn(`Lead ${email} not found in Instantly campaign ${campaignId} — skipping`);
      return;
    }
    handleAxiosError(err, 'removeLead');
  }
}

/**
 * Fetch aggregated send/open/click/reply counts for a campaign.
 */
export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const client = getClient();
  logger.info(`Fetching analytics for Instantly campaign ${campaignId}`);
  try {
    const { data } = await client.get(`/campaigns/${campaignId}/analytics`);
    return {
      sent:    data?.total_sent    ?? data?.sent    ?? 0,
      opened:  data?.total_opened  ?? data?.opened  ?? 0,
      clicked: data?.total_clicked ?? data?.clicked ?? 0,
      replied: data?.total_replied ?? data?.replied ?? 0,
    };
  } catch (err) {
    handleAxiosError(err, 'getCampaignAnalytics');
  }
}
