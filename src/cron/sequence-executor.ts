import {
  getReadyEnrollments,
  updateEnrollment,
  logEngagement,
  getEnrollmentEngagements,
  createCallTask,
  getUserSmartleadCredentials,
} from '../services/supabase';
import { addLeadToCampaign } from '../services/smartlead';
import { replaceVariables } from '../utils/variables';
import { createLogger } from '../utils/logger';

const logger = createLogger('SequenceExecutor');

export async function executeSequences() {
  logger.info('Starting sequence execution...');

  try {
    const enrollments = await getReadyEnrollments();

    if (enrollments.length === 0) {
      logger.info('No enrollments ready to process');
      return;
    }

    logger.info(`Processing ${enrollments.length} enrollments...`);

    for (const enrollment of enrollments) {
      try {
        await processEnrollment(enrollment);
      } catch (error) {
        logger.error(`Failed to process enrollment ${enrollment.id}`, error);
      }
    }

    logger.info('Sequence execution complete');
  } catch (error) {
    logger.error('Error executing sequences', error);
  }
}

async function processEnrollment(enrollment: any) {
  const contact = enrollment.contacts;
  const sequence = enrollment.sequences;
  const currentStepNumber = enrollment.current_step;

  logger.info(`Processing enrollment ${enrollment.id}, step ${currentStepNumber}`);

  // Get the user's Smartlead credentials
  const createdBy = sequence.created_by;
  if (!createdBy) {
    logger.error(`Sequence ${sequence.id} has no created_by user`);
    return;
  }

  let smartleadCreds;
  try {
    smartleadCreds = await getUserSmartleadCredentials(createdBy);
  } catch (error: any) {
    logger.error(`User ${createdBy} has not connected Smartlead account`, error);
    return;
  }

  // Find the current step
  const currentStep = sequence.sequence_steps?.find(
    (s: any) => s.step_number === currentStepNumber
  );

  if (!currentStep) {
    logger.error(`Step ${currentStepNumber} not found for enrollment ${enrollment.id}`);
    return;
  }

  // Check if conditions are met (for steps > 1)
  if (currentStepNumber > 1) {
    const conditionsMet = await checkStepConditions(enrollment.id, currentStep);
    if (!conditionsMet) {
      logger.info(`Conditions not met for enrollment ${enrollment.id}, skipping to next step`);
      await skipToNextStep(enrollment, sequence.sequence_steps);
      return;
    }
  }

  // Process based on step type
  if (currentStep.step_type === 'email') {
    await processEmailStep(enrollment, contact, sequence, currentStep, smartleadCreds);
  } else if (currentStep.step_type === 'call') {
    await processCallStep(enrollment, contact, sequence, currentStep);
  }

  // Move to next step
  await moveToNextStep(enrollment, sequence.sequence_steps);
}

async function processEmailStep(
  enrollment: any,
  contact: any,
  sequence: any,
  step: any,
  smartleadCreds: { apiKey: string; emailAccountId: string }
) {
  logger.info(`Sending email step ${step.step_number} to ${contact.email}`);

  // Replace variables in subject and body
  const subject = replaceVariables(step.subject, contact);
  const body = replaceVariables(step.body, contact);

  // Get Smartlead campaign ID
  const campaignId = sequence.smartlead_campaign_id;
  if (!campaignId) {
    logger.error(`No Smartlead campaign ID for sequence ${sequence.id}`);
    return;
  }

  try {
    // Add contact to Smartlead campaign using user's API key
    const leadId = await addLeadToCampaign(
      smartleadCreds.apiKey,
      campaignId,
      {
        email: contact.email,
        first_name: contact.first_name,
        last_name: contact.last_name,
        company: contact.company,
      }
    );

    // Log engagement (email sent)
    await logEngagement({
      contact_id: contact.id,
      sequence_id: sequence.id,
      enrollment_id: enrollment.id,
      engagement_type: 'email_sent',
      metadata: {
        step_number: step.step_number,
        subject,
        smartlead_lead_id: leadId,
        smartlead_campaign_id: campaignId,
      },
    });

    logger.info(`Email sent successfully to ${contact.email}`);
  } catch (error) {
    logger.error(`Failed to send email to ${contact.email}`, error);
    throw error;
  }
}

async function processCallStep(enrollment: any, contact: any, sequence: any, step: any) {
  logger.info(`Creating call task for step ${step.step_number} - ${contact.email}`);

  try {
    // Create a call task record
    await createCallTask({
      contact_id: contact.id,
      sequence_id: sequence.id,
      enrollment_id: enrollment.id,
      call_objective: step.call_objective,
      call_script: step.call_script,
    });

    // Log engagement (call scheduled)
    await logEngagement({
      contact_id: contact.id,
      sequence_id: sequence.id,
      enrollment_id: enrollment.id,
      engagement_type: 'email_sent', // Using email_sent as placeholder
      metadata: {
        step_number: step.step_number,
        step_type: 'call',
        call_objective: step.call_objective,
      },
    });

    logger.info(`Call task created for ${contact.email}`);
  } catch (error) {
    logger.error(`Failed to create call task for ${contact.email}`, error);
    throw error;
  }
}

async function checkStepConditions(enrollmentId: string, step: any): Promise<boolean> {
  // If no conditions, always proceed
  if (
    !step.condition_previous_opened &&
    !step.condition_previous_clicked &&
    !step.condition_not_replied
  ) {
    return true;
  }

  // Get engagement history for previous step
  const engagements = await getEnrollmentEngagements(enrollmentId, step.step_number - 1);

  const opened = engagements.some(e => e.engagement_type === 'email_opened');
  const clicked = engagements.some(e => e.engagement_type === 'email_clicked');
  const replied = engagements.some(e => e.engagement_type === 'email_replied');

  // Evaluate conditions
  if (step.condition_previous_opened && !opened) return false;
  if (step.condition_previous_clicked && !clicked) return false;
  if (step.condition_not_replied && replied) return false;

  return true;
}

async function moveToNextStep(enrollment: any, allSteps: any[]) {
  const nextStepNumber = enrollment.current_step + 1;
  const nextStep = allSteps?.find((s: any) => s.step_number === nextStepNumber);

  if (!nextStep) {
    // Sequence complete
    await updateEnrollment(enrollment.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    logger.info(`Enrollment ${enrollment.id} completed`);
    return;
  }

  // Calculate next send time
  const nextSendAt = new Date();
  nextSendAt.setDate(nextSendAt.getDate() + (nextStep.delay_days || 0));
  nextSendAt.setHours(nextSendAt.getHours() + (nextStep.delay_hours || 0));

  await updateEnrollment(enrollment.id, {
    current_step: nextStepNumber,
    next_send_at: nextSendAt.toISOString(),
  });

  logger.info(`Enrollment ${enrollment.id} moved to step ${nextStepNumber}`);
}

async function skipToNextStep(enrollment: any, allSteps: any[]) {
  logger.info(`Skipping step ${enrollment.current_step} for enrollment ${enrollment.id}`);
  await moveToNextStep(enrollment, allSteps);
}
