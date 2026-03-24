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
  id:       string;   // OutboundHQ sequence ID (used for deduplication label)
  name:     string;
  steps:    SequenceStepInput[];
  fromName: string;   // SDR's display name  e.g. "Jane Smith"
  replyTo:  string;   // SDR's email address
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

  // 1. Create the campaign shell
  let campaignId: string;
  try {
    const { data } = await client.post('/campaigns', {
      name:       input.name,
      from_name:  input.fromName,
      reply_to:   input.replyTo,
    });
    campaignId = String(data.id ?? data.campaign_id ?? '');
    if (!campaignId) throw new Error('Instantly did not return a campaign ID');
    logger.info(`Instantly campaign created: ${campaignId}`);
  } catch (err) {
    handleAxiosError(err, 'createCampaign');
  }

  // 2. Add sequence steps
  const sequences = [
    {
      steps: input.steps.map((step) => ({
        type:  'email',
        delay: step.delay_days * 24, // Instantly expects delay in hours
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

  // Split into batches of LEAD_BATCH_SIZE
  for (let i = 0; i < leads.length; i += LEAD_BATCH_SIZE) {
    const batch = leads.slice(i, i + LEAD_BATCH_SIZE);

    try {
      await client.post(`/campaigns/${campaignId}/leads`, {
        lead_list: batch.map((l) => ({
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
    await client.patch(`/campaigns/${campaignId}`, { status: 'paused' });
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
    await client.patch(`/campaigns/${campaignId}`, { status: 'active' });
  } catch (err) {
    handleAxiosError(err, 'resumeCampaign');
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
