import { Router, Request, Response } from 'express';
import {
  getSequenceWithSteps,
  getContact,
  getUserProfile,
  createEnrollment,
  getActiveEnrollment,
  getEnrollmentById,
  updateEnrollmentStatus,
  logEngagement,
  logEmailMessage,
} from '../services/supabase';
import { bulkAddLeadsToCampaign } from '../services/instantly';
import { replaceVariables } from '../utils/variables';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('EnrollmentsRoute');

// ─────────────────────────────────────────────
// POST /api/enrollments/create
// Enrolls a contact in an active sequence via Instantly.
// ─────────────────────────────────────────────

router.post('/create', async (req: Request, res: Response): Promise<void> => {
  const { sequenceId, contactId, userId } = req.body as {
    sequenceId?: string;
    contactId?:  string;
    userId?:     string;
  };

  if (!sequenceId || !contactId || !userId) {
    res.status(400).json({ error: 'sequenceId, contactId, and userId are required' });
    return;
  }

  logger.info(`Enroll contact ${contactId} in sequence ${sequenceId} by user ${userId}`);

  try {
    // 1. Verify the sequence is active and has an Instantly campaign
    const sequence = await getSequenceWithSteps(sequenceId);

    if (!sequence) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    if (sequence.status !== 'active') {
      res.status(400).json({
        error: `Sequence is not active (current status: ${sequence.status}). Activate it first.`,
      });
      return;
    }

    if (!sequence.instantly_campaign_id) {
      res.status(400).json({ error: 'Sequence has no linked Instantly campaign. Activate it first.' });
      return;
    }

    // 2. Prevent duplicate enrollments
    const existing = await getActiveEnrollment(sequenceId, contactId);
    if (existing) {
      res.status(409).json({
        error: 'Contact is already actively enrolled in this sequence',
        enrollmentId: existing.id,
      });
      return;
    }

    // 3. Fetch the contact
    const contact = await getContact(contactId);
    if (!contact) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    // 4. Fetch SDR profile for from_name / reply_to
    const profile = await getUserProfile(userId);

    // 5. Add lead to Instantly campaign
    await bulkAddLeadsToCampaign(sequence.instantly_campaign_id, [
      {
        email:        contact.email,
        first_name:   contact.first_name   ?? undefined,
        last_name:    contact.last_name    ?? undefined,
        company_name: contact.company      ?? undefined,
      },
    ]);

    // 6. Create enrollment record
    const enrollment = await createEnrollment({
      sequenceId,
      contactId,
      userId,
      smartleadLeadId: '',   // not applicable for Instantly; kept for schema compat
    });

    // 7. Log intent engagement for step 1
    await logEngagement({
      contactId,
      sequenceId,
      enrollmentId:   enrollment.id,
      engagementType: 'email_sent',
      metadata: {
        step:                  1,
        note:                  'Initial enrollment — Instantly will handle delivery',
        instantly_campaign_id: sequence.instantly_campaign_id,
      },
    });

    // 8. Log the outbound email message (step 1) for conversation threading
    const step1 = (sequence.sequence_steps ?? [])
      .filter((s) => s.step_type === 'email')
      .sort((a, b) => a.step_number - b.step_number)[0];

    if (step1) {
      const contactVars = {
        first_name: contact.first_name,
        last_name:  contact.last_name,
        company:    contact.company,
        email:      contact.email,
      };

      await logEmailMessage({
        contactId,
        enrollmentId:         enrollment.id,
        sequenceId,
        assignedSdrId:        userId,
        direction:            'outbound',
        subject:              replaceVariables(step1.subject ?? '', contactVars),
        bodyText:             replaceVariables(step1.body    ?? '', contactVars),
        fromAddress:          profile.email ?? undefined,
        toAddress:            contact.email,
        instantlyCampaignId:  sequence.instantly_campaign_id,
        status:               'delivered',
        sentAt:               new Date().toISOString(),
      });
    }

    logger.info(
      `Contact ${contactId} enrolled in sequence ${sequenceId} → enrollment ${enrollment.id}`
    );

    res.status(200).json({
      success: true,
      enrollment,
      instantly_campaign_id: sequence.instantly_campaign_id,
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to enroll contact ${contactId}`, error);

    if (error.message?.includes('not found') || error.message?.includes('No rows')) {
      res.status(404).json({ error: 'Resource not found', details: error.message });
      return;
    }

    res.status(500).json({ error: 'Failed to enroll contact', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/enrollments/:id/pause
// ─────────────────────────────────────────────

router.post('/:id/pause', async (req: Request, res: Response): Promise<void> => {
  const { id: enrollmentId } = req.params;

  logger.info(`Pause request for enrollment ${enrollmentId}`);

  try {
    const enrollment = await getEnrollmentById(enrollmentId);

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    if (enrollment.status !== 'active') {
      res.status(400).json({
        error: `Enrollment cannot be paused (current status: ${enrollment.status})`,
      });
      return;
    }

    await updateEnrollmentStatus(enrollmentId, 'paused');

    logger.info(`Enrollment ${enrollmentId} paused`);

    res.status(200).json({ success: true, enrollmentId, status: 'paused' });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to pause enrollment ${enrollmentId}`, error);
    res.status(500).json({ error: 'Failed to pause enrollment', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/enrollments/:id/resume
// ─────────────────────────────────────────────

router.post('/:id/resume', async (req: Request, res: Response): Promise<void> => {
  const { id: enrollmentId } = req.params;

  logger.info(`Resume request for enrollment ${enrollmentId}`);

  try {
    const enrollment = await getEnrollmentById(enrollmentId);

    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    if (enrollment.status !== 'paused') {
      res.status(400).json({
        error: `Enrollment cannot be resumed (current status: ${enrollment.status})`,
      });
      return;
    }

    await updateEnrollmentStatus(enrollmentId, 'active');

    logger.info(`Enrollment ${enrollmentId} resumed`);

    res.status(200).json({ success: true, enrollmentId, status: 'active' });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to resume enrollment ${enrollmentId}`, error);
    res.status(500).json({ error: 'Failed to resume enrollment', details: error.message });
  }
});

export default router;
