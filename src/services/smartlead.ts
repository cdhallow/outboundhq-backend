import axios, { AxiosInstance } from 'axios';

const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY!;
const SMARTLEAD_BASE_URL = 'https://server.smartlead.ai/api/v1';

if (!SMARTLEAD_API_KEY) {
  throw new Error('Missing SMARTLEAD_API_KEY environment variable');
}

const smartleadClient: AxiosInstance = axios.create({
  baseURL: SMARTLEAD_BASE_URL,
  headers: {
    'Authorization': `Bearer ${SMARTLEAD_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// Create a campaign in Smartlead
export async function createCampaign(sequence: {
  id: string;
  name: string;
  steps: Array<{
    step_number: number;
    subject: string;
    body: string;
    delay_days: number;
  }>;
}) {
  try {
    console.log(`[SMARTLEAD] Creating campaign: ${sequence.name}`);

    const response = await smartleadClient.post('/campaigns', {
      name: sequence.name,
      email_accounts: [process.env.SMARTLEAD_EMAIL_ACCOUNT_ID],
      settings: {
        daily_limit: 50,
        time_zone: 'America/New_York',
        track_opens: true,
        track_clicks: true,
      },
    });

    const campaignId = response.data.id;
    console.log(`[SMARTLEAD] Campaign created: ${campaignId}`);

    // Add email sequences (steps)
    for (const step of sequence.steps) {
      await smartleadClient.post(`/campaigns/${campaignId}/sequences`, {
        sequence_number: step.step_number,
        subject: step.subject,
        body: step.body,
        delay_in_days: step.delay_days,
      });
      console.log(`[SMARTLEAD] Added step ${step.step_number} to campaign ${campaignId}`);
    }

    return campaignId;
  } catch (error: any) {
    console.error('[SMARTLEAD] Campaign creation failed:', error.response?.data || error.message);
    throw error;
  }
}

// Add lead (contact) to Smartlead campaign
export async function addLeadToCampaign(
  campaignId: string,
  contact: {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
  }
) {
  try {
    console.log(`[SMARTLEAD] Adding lead to campaign ${campaignId}: ${contact.email}`);

    const response = await smartleadClient.post(`/campaigns/${campaignId}/leads`, {
      email: contact.email,
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      company_name: contact.company || '',
    });

    const leadId = response.data.lead_id || response.data.id;
    console.log(`[SMARTLEAD] Lead added: ${leadId}`);
    return leadId;
  } catch (error: any) {
    // If lead already exists, that's okay - Smartlead will handle it
    if (error.response?.status === 409 || error.response?.data?.message?.includes('already exists')) {
      console.log(`[SMARTLEAD] Lead already exists: ${contact.email}`);
      return null;
    }
    console.error('[SMARTLEAD] Lead addition failed:', error.response?.data || error.message);
    throw error;
  }
}

// Send email immediately (for testing or manual triggers)
export async function sendEmailNow(
  campaignId: string,
  leadId: string,
  stepNumber: number
) {
  try {
    console.log(`[SMARTLEAD] Triggering immediate send for lead ${leadId}, step ${stepNumber}`);

    await smartleadClient.post(`/campaigns/${campaignId}/leads/${leadId}/send`, {
      sequence_number: stepNumber,
    });

    console.log(`[SMARTLEAD] Email sent successfully`);
  } catch (error: any) {
    console.error('[SMARTLEAD] Send failed:', error.response?.data || error.message);
    throw error;
  }
}

// Get campaign details
export async function getCampaign(campaignId: string) {
  try {
    const response = await smartleadClient.get(`/campaigns/${campaignId}`);
    return response.data;
  } catch (error: any) {
    console.error('[SMARTLEAD] Get campaign failed:', error.response?.data || error.message);
    throw error;
  }
}
