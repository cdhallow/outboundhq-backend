import axios, { AxiosInstance, AxiosError } from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger('SmartleadService');

const BASE_URL = 'https://server.smartlead.ai/api/v1';

// ─────────────────────────────────────────────
// HTTP client factory
// ─────────────────────────────────────────────

function makeClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });
}

/** Unwrap Axios errors into something readable for logs. */
function handleAxiosError(error: unknown, context: string): never {
  if (error instanceof AxiosError) {
    const status  = error.response?.status;
    const message = error.response?.data?.message ?? error.message;
    logger.error(`${context} failed [${status}]: ${message}`, error.response?.data);
    throw new Error(`Smartlead API error in ${context}: ${message} (HTTP ${status})`);
  }
  throw error;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SequenceStepInput {
  step_number: number;
  subject: string;
  body: string;
  delay_days: number;
}

export interface SequenceInput {
  id: string;
  name: string;
  steps: SequenceStepInput[];
}

export interface ContactInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
}

export interface CampaignStats {
  sent:    number;
  opened:  number;
  clicked: number;
  replied: number;
}

// ─────────────────────────────────────────────
// Campaign management
// ─────────────────────────────────────────────

/**
 * Create a Smartlead campaign from an OutboundHQ sequence.
 * Steps are sent in a single POST to /campaigns/:id/sequences.
 * Returns the Smartlead campaign ID as a string.
 */
export async function createCampaignFromSequence(
  apiKey: string,
  emailAccountId: string,
  sequence: SequenceInput
): Promise<string> {
  const client = makeClient(apiKey);

  // 1. Create the campaign shell
  logger.info(`Creating Smartlead campaign for sequence "${sequence.name}" (${sequence.id})`);

  let campaignId: string;
  try {
    const { data } = await client.post('/campaigns', {
      name: sequence.name,
      // Attach the sending email account
      email_account_ids: [emailAccountId],
    });
    campaignId = String(data.id);
    logger.info(`Campaign created with Smartlead ID: ${campaignId}`);
  } catch (err) {
    handleAxiosError(err, 'createCampaign');
  }

  // 2. Add email sequence steps
  //    Smartlead expects an array of sequence objects, each with a seq_number,
  //    seq_delay_details, and variants array (subject/body pairs).
  const sequences = sequence.steps.map((step) => ({
    seq_number: step.step_number,
    seq_delay_details: {
      delay_in_days: step.delay_days,
    },
    variants: [
      {
        subject: step.subject,
        body:    step.body,
      },
    ],
  }));

  try {
    await client.post(`/campaigns/${campaignId!}/sequences`, { sequences });
    logger.info(`Added ${sequences.length} step(s) to campaign ${campaignId}`);
  } catch (err) {
    handleAxiosError(err, 'addSequenceSteps');
  }

  return campaignId!;
}

// ─────────────────────────────────────────────
// Lead management
// ─────────────────────────────────────────────

/**
 * Add a single lead to an existing Smartlead campaign.
 * Returns the Smartlead lead ID as a string.
 */
export async function addLeadToCampaign(
  apiKey: string,
  campaignId: string,
  contact: ContactInput
): Promise<string> {
  const client = makeClient(apiKey);

  logger.info(`Adding lead ${contact.email} to campaign ${campaignId}`);

  try {
    const { data } = await client.post(`/campaigns/${campaignId}/leads`, {
      lead_list: [
        {
          email:      contact.email,
          first_name: contact.first_name ?? '',
          last_name:  contact.last_name  ?? '',
          company:    contact.company    ?? '',
        },
      ],
    });

    // Smartlead returns an array; grab the first entry's id
    const leadId = String(
      data?.uploaded_leads?.[0]?.id ??
      data?.lead_id ??
      data?.id ??
      ''
    );

    if (!leadId) {
      throw new Error(`Smartlead did not return a lead ID for ${contact.email}`);
    }

    logger.info(`Lead added with Smartlead ID: ${leadId}`);
    return leadId;
  } catch (err) {
    handleAxiosError(err, 'addLeadToCampaign');
  }
}

// ─────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────

/**
 * Fetch aggregated send/open/click/reply counts for a campaign.
 */
export async function getCampaignStats(
  apiKey: string,
  campaignId: string
): Promise<CampaignStats> {
  const client = makeClient(apiKey);

  logger.info(`Fetching analytics for campaign ${campaignId}`);

  try {
    const { data } = await client.get(`/campaigns/${campaignId}/analytics`);

    return {
      sent:    data?.total_sent    ?? 0,
      opened:  data?.total_opened  ?? 0,
      clicked: data?.total_clicked ?? 0,
      replied: data?.total_replied ?? 0,
    };
  } catch (err) {
    handleAxiosError(err, 'getCampaignStats');
  }
}

// ─────────────────────────────────────────────
// Campaign status control
// ─────────────────────────────────────────────

export async function pauseCampaign(apiKey: string, campaignId: string): Promise<void> {
  const client = makeClient(apiKey);
  logger.info(`Pausing campaign ${campaignId}`);
  try {
    await client.post(`/campaigns/${campaignId}/pause`);
  } catch (err) {
    handleAxiosError(err, 'pauseCampaign');
  }
}

export async function resumeCampaign(apiKey: string, campaignId: string): Promise<void> {
  const client = makeClient(apiKey);
  logger.info(`Resuming campaign ${campaignId}`);
  try {
    await client.post(`/campaigns/${campaignId}/resume`);
  } catch (err) {
    handleAxiosError(err, 'resumeCampaign');
  }
}
