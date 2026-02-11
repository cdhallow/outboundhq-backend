import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Helper: Fetch enrollments ready to be processed
export async function getReadyEnrollments() {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select(`
      id,
      contact_id,
      sequence_id,
      current_step,
      next_send_at,
      status,
      contacts (
        id,
        email,
        first_name,
        last_name,
        company,
        phone
      ),
      sequences!inner (
        id,
        name,
        smartlead_campaign_id,
        sequence_steps (
          id,
          step_number,
          step_type,
          subject,
          body,
          delay_days,
          delay_hours,
          call_objective,
          call_script,
          condition_previous_opened,
          condition_previous_clicked,
          condition_not_replied
        )
      )
    `)
    .eq('status', 'active')
    .lte('next_send_at', new Date().toISOString())
    .order('next_send_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

// Helper: Update enrollment after processing
export async function updateEnrollment(
  enrollmentId: string,
  updates: {
    current_step?: number;
    next_send_at?: string;
    status?: string;
    completed_at?: string;
  }
) {
  const { error } = await supabase
    .from('sequence_enrollments')
    .update(updates)
    .eq('id', enrollmentId);

  if (error) throw error;
}

// Helper: Log engagement
export async function logEngagement(engagement: {
  contact_id: string;
  sequence_id: string;
  enrollment_id: string;
  engagement_type: 'email_sent' | 'email_opened' | 'email_clicked' | 'email_replied' | 'email_bounced';
  metadata?: any;
}) {
  const { error } = await supabase
    .from('engagements')
    .insert([{
      ...engagement,
      engaged_at: new Date().toISOString(),
    }]);

  if (error) {
    console.error('Error logging engagement:', error);
    throw error;
  }
}

// Helper: Get engagement history for an enrollment
export async function getEnrollmentEngagements(enrollmentId: string, stepNumber: number) {
  const { data, error } = await supabase
    .from('engagements')
    .select('engagement_type, metadata')
    .eq('enrollment_id', enrollmentId);

  if (error) {
    console.error('Error fetching engagements:', error);
    return [];
  }

  // Filter for the specific step (stored in metadata)
  return (data || []).filter(e => {
    const metadata = e.metadata as any;
    return metadata?.step_number === stepNumber;
  });
}

// Helper: Update contact engagement score
export async function updateContactScore(contactId: string, points: number) {
  try {
    // Fetch current score
    const { data: contact } = await supabase
      .from('contacts')
      .select('engagement_score')
      .eq('id', contactId)
      .single();

    const currentScore = contact?.engagement_score || 0;
    const newScore = currentScore + points;

    await supabase
      .from('contacts')
      .update({ engagement_score: newScore })
      .eq('id', contactId);

    console.log(`[SCORE] Updated contact ${contactId}: ${currentScore} → ${newScore} (+${points})`);
  } catch (error) {
    console.error('Error updating contact score:', error);
  }
}

// Helper: Create call task
export async function createCallTask(data: {
  contact_id: string;
  sequence_id: string;
  enrollment_id: string;
  call_objective: string;
  call_script?: string;
}) {
  const { error } = await supabase
    .from('calls')
    .insert([{
      ...data,
      status: 'scheduled',
      scheduled_at: new Date().toISOString(),
    }]);

  if (error) {
    console.error('Error creating call task:', error);
    throw error;
  }
}
