import axios, { AxiosInstance } from 'axios';

const SMARTLEAD_BASE_URL = 'https://server.smartlead.ai/api/v1';

// Create Smartlead client with user's API key
function createSmartleadClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: SMARTLEAD_BASE_URL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
}

// Fetch user's email accounts from Smartlead
export async function fetchEmailAccounts(apiKey: string) {
  try {
    const client = createSmartleadClient(apiKey);
    const response = await client.get('/email-accounts');
    return response.data;
  } catch (error: any) {
    console.error('[SMARTLEAD] Failed to fetch email accounts:', error.response?.data || error.message);
    throw error;
  }
}

// Create a campaign in Smartlead using user's API key
export async function createCampaign(
  apiKey: string,
  emailAccountId: string,
  sequence: {
    id: string;
    name: string;
    steps: Array<{
      step_number: number;
      subject: string;
      body: string;
      delay_days: number;
    }>;
  }
) {
  try {
    const client = createSmartleadClient(apiKey);
    
    console.log(`[SMARTLEAD] Creating campaign: ${sequence.name}`);

    const response = await client.post('/campaigns', {
      name: sequence.name,
      email_accounts: [emailAccountId],
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
      await client.post(`/campaigns/${campaignId}/sequences`, {
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
  apiKey: string,
  campaignId: string,
  contact: {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
  }
) {
  try {
    const client = createSmartleadClient(apiKey);
    
    console.log(`[SMARTLEAD] Adding lead to campaign ${campaignId}: ${contact.email}`);

    const response = await client.post(`/campaigns/${campaignId}/leads`, {
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
  apiKey: string,
  campaignId: string,
  leadId: string,
  stepNumber: number
) {
  try {
    const client = createSmartleadClient(apiKey);
    
    console.log(`[SMARTLEAD] Triggering immediate send for lead ${leadId}, step ${stepNumber}`);

    await client.post(`/campaigns/${campaignId}/leads/${leadId}/send`, {
      sequence_number: stepNumber,
    });

    console.log(`[SMARTLEAD] Email sent successfully`);
  } catch (error: any) {
    console.error('[SMARTLEAD] Send failed:', error.response?.data || error.message);
    throw error;
  }
}

// Get campaign details
export async function getCampaign(apiKey: string, campaignId: string) {
  try {
    const client = createSmartleadClient(apiKey);
    const response = await client.get(`/campaigns/${campaignId}`);
    return response.data;
  } catch (error: any) {
    console.error('[SMARTLEAD] Get campaign failed:', error.response?.data || error.message);
    throw error;
  }
}
