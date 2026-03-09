import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  step_type: 'email' | 'call';
  subject: string | null;
  body: string | null;
  delay_days: number;
  delay_hours: number;
  condition_previous_opened: boolean;
  condition_previous_clicked: boolean;
  condition_not_replied: boolean;
}

export interface Sequence {
  id: string;
  name: string;
  created_by: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  smartlead_campaign_id: string | null;
  created_at: string;
  updated_at: string;
  sequence_steps: SequenceStep[];
}

export interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  engagement_score: number;
}

export interface Enrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  user_id: string;
  status: 'active' | 'paused' | 'completed' | 'bounced' | 'unsubscribed';
  current_step: number;
  smartlead_lead_id: string | null;
  enrolled_at: string;
  completed_at: string | null;
  sequences?: Sequence;
  contacts?: Contact;
}

export type EngagementType =
  | 'email_sent'
  | 'email_opened'
  | 'email_clicked'
  | 'email_replied'
  | 'email_bounced';

// ─────────────────────────────────────────────
// Sequences
// ─────────────────────────────────────────────

/** Fetch a sequence together with all its steps, ordered by step_number. */
export async function getSequenceWithSteps(sequenceId: string): Promise<Sequence> {
  const { data, error } = await supabase
    .from('sequences')
    .select(`
      *,
      sequence_steps (
        id,
        step_number,
        step_type,
        subject,
        body,
        delay_days,
        delay_hours,
        condition_previous_opened,
        condition_previous_clicked,
        condition_not_replied
      )
    `)
    .eq('id', sequenceId)
    .order('step_number', { referencedTable: 'sequence_steps', ascending: true })
    .single();

  if (error) throw error;
  return data as Sequence;
}

/** Persist the Smartlead campaign ID onto the sequence and flip status → active. */
export async function updateSequenceWithCampaignId(
  sequenceId: string,
  campaignId: string
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({
      smartlead_campaign_id: campaignId,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sequenceId);

  if (error) throw error;
}

/** Update only the status of a sequence. */
export async function updateSequenceStatus(
  sequenceId: string,
  status: 'draft' | 'active' | 'paused' | 'completed'
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', sequenceId);

  if (error) throw error;
}

// ─────────────────────────────────────────────
// Profiles / Smartlead credentials
// ─────────────────────────────────────────────

export interface SmartleadCredentials {
  apiKey: string;
  emailAccountId: string;
}

/** Retrieve and validate a user's Smartlead API key + email account. */
export async function getUserSmartleadCredentials(
  userId: string
): Promise<SmartleadCredentials> {
  const { data, error } = await supabase
    .from('profiles')
    .select('smartlead_api_key, smartlead_email_account_id')
    .eq('id', userId)
    .single();

  if (error) throw error;

  if (!data?.smartlead_api_key || !data?.smartlead_email_account_id) {
    const err = new Error('User has not connected Smartlead account') as Error & { code: string };
    err.code = 'SMARTLEAD_NOT_CONNECTED';
    throw err;
  }

  return {
    apiKey: data.smartlead_api_key,
    emailAccountId: data.smartlead_email_account_id,
  };
}

// ─────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────

export async function getContact(contactId: string): Promise<Contact> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();

  if (error) throw error;
  return data as Contact;
}

/** Atomically add points to a contact's engagement score. */
export async function updateContactEngagementScore(
  contactId: string,
  pointsToAdd: number
): Promise<void> {
  // Read → add → write (Supabase doesn't support increment expressions via the REST API,
  // so we do a manual read+write wrapped in a lightweight check).
  const { data: contact } = await supabase
    .from('contacts')
    .select('engagement_score')
    .eq('id', contactId)
    .single();

  const newScore = (contact?.engagement_score ?? 0) + pointsToAdd;

  const { error } = await supabase
    .from('contacts')
    .update({ engagement_score: newScore })
    .eq('id', contactId);

  if (error) throw error;
}

/** Mark a contact's email as invalid after a hard bounce. */
export async function markContactEmailInvalid(contactId: string): Promise<void> {
  const { error } = await supabase
    .from('contacts')
    .update({ email_invalid: true } as Record<string, unknown>)
    .eq('id', contactId);

  if (error) throw error;
}

/** Mark a contact as unsubscribed. */
export async function markContactUnsubscribed(contactId: string): Promise<void> {
  const { error } = await supabase
    .from('contacts')
    .update({ unsubscribed: true } as Record<string, unknown>)
    .eq('id', contactId);

  if (error) throw error;
}

// ─────────────────────────────────────────────
// Enrollments
// ─────────────────────────────────────────────

export interface CreateEnrollmentInput {
  sequenceId: string;
  contactId: string;
  userId: string;
  smartleadLeadId: string;
}

export async function createEnrollment(input: CreateEnrollmentInput): Promise<Enrollment> {
  const { data: enrollment, error } = await supabase
    .from('sequence_enrollments')
    .insert([{
      sequence_id:       input.sequenceId,
      contact_id:        input.contactId,
      user_id:           input.userId,
      smartlead_lead_id: input.smartleadLeadId,
      status:            'active',
      current_step:      1,
      enrolled_at:       new Date().toISOString(),
    }])
    .select()
    .single();

  if (error) throw error;
  return enrollment as Enrollment;
}

/** Check whether a contact is already enrolled (and active) in a sequence. */
export async function getActiveEnrollment(
  sequenceId: string,
  contactId: string
): Promise<Enrollment | null> {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw error;
  return data as Enrollment | null;
}

export async function getEnrollmentById(enrollmentId: string): Promise<Enrollment | null> {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select('*')
    .eq('id', enrollmentId)
    .maybeSingle();

  if (error) throw error;
  return data as Enrollment | null;
}

/** Find an enrollment by the Smartlead lead ID, joining sequences and contacts. */
export async function findEnrollmentBySmartleadId(
  smartleadLeadId: string
): Promise<Enrollment | null> {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select('*, sequences(*), contacts(*)')
    .eq('smartlead_lead_id', smartleadLeadId)
    .maybeSingle();

  if (error) throw error;
  return data as Enrollment | null;
}

export async function updateEnrollmentStatus(
  enrollmentId: string,
  status: Enrollment['status']
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (status === 'completed') {
    updates['completed_at'] = new Date().toISOString();
  }

  const { error } = await supabase
    .from('sequence_enrollments')
    .update(updates)
    .eq('id', enrollmentId);

  if (error) throw error;
}

// ─────────────────────────────────────────────
// Engagements
// ─────────────────────────────────────────────

export interface LogEngagementInput {
  contactId: string;
  sequenceId: string;
  enrollmentId: string;
  engagementType: EngagementType;
  metadata?: Record<string, unknown>;
}

export async function logEngagement(input: LogEngagementInput): Promise<void> {
  const { error } = await supabase
    .from('engagements')
    .insert([{
      contact_id:      input.contactId,
      sequence_id:     input.sequenceId,
      enrollment_id:   input.enrollmentId,
      engagement_type: input.engagementType,
      engaged_at:      new Date().toISOString(),
      metadata:        input.metadata ?? {},
    }]);

  if (error) throw error;
}

/** Pull engagement counts for a sequence from our own engagements table. */
export async function getLocalEngagementCounts(sequenceId: string) {
  const { data, error } = await supabase
    .from('engagements')
    .select('engagement_type')
    .eq('sequence_id', sequenceId);

  if (error) throw error;

  const counts = {
    email_sent:    0,
    email_opened:  0,
    email_clicked: 0,
    email_replied: 0,
    email_bounced: 0,
  };

  for (const row of data ?? []) {
    const t = row.engagement_type as EngagementType;
    if (t in counts) counts[t]++;
  }

  return counts;
}
