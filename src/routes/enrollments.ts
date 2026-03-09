import { Router, Request, Response } from 'express';
import {
  getSequenceWithSteps,
  getContact,
  getUserSmartleadCredentials,
  createEnrollment,
  getActiveEnrollment,
  getEnrollmentById,
  updateEnrollmentStatus,
  logEngagement,
} from '../services/supabase';
import { addLeadToCampaign } from '../services/smartlead';
import { replaceVariables } from '../utils/variables';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('EnrollmentsRoute');

// ─────────────────────────────────────────────
// POST /api/enrollments/create
// Enrolls a contact in an active sequence by adding them to Smartlead.
// ─────────────────────────────────────────────

router.post('/create', async (req: Request, res: Response): Promise<void> => {
  const { sequenceId, contactId, userId } = req.body as {
    sequenceId?: string;
    contactId?: string;
    userId?: string;
  };

  // Validate required fields
  if (!sequenceId || !contactId || !userId) {
    res.status(400).json({ error: 'sequenceId, contactId, and userId are required' });
    return;
  }

  logger.info(`Enroll contact ${contactId} in sequence ${sequenceId} by user ${userId}`);

  try {
    // 1. Verify the sequence is active and has a Smartlead campaign
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

    if (!sequence.smartlead_campaign_id) {
      res.status(400).json({ error: 'Sequence has no linked Smartlead campaign. Activate it first.' });
      return;
    }

    // 2. Check for an existing active enrollment (no duplicate enrollments)
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

    // 4. Get credentials from the sequence owner (created_by), not necessarily the
    //    enrolling user — keeps campaigns consistent per-account.
    const credentialUserId = sequence.created_by ?? userId;
    const { apiKey } = await getUserSmartleadCredentials(credentialUserId);

    // 5. Add lead to Smartlead campaign
    const smartleadLeadId = await addLeadToCampaign(
      apiKey,
      sequence.smartlead_campaign_id,
      {
        email:      contact.email,
        first_name: contact.first_name ?? undefined,
        last_name:  contact.last_name  ?? undefined,
        company:    contact.company    ?? undefined,
      }
    );

    // 6. Create the enrollment record in Supabase
    const enrollment = await createEnrollment({
      sequenceId,
      contactId,
      userId,
      smartleadLeadId,
    });

    // 7. Log an email_sent engagement for step 1 (Smartlead will actually send it,
    //    but we record the intent immediately so the UI reflects the action).
    await logEngagement({
      contactId,
      sequenceId,
      enrollmentId: enrollment.id,
      engagementType: 'email_sent',
      metadata: {
        step: 1,
        note: 'Initial enrollment - Smartlead will handle delivery',
        smartlead_lead_id: smartleadLeadId,
        smartlead_campaign_id: sequence.smartlead_campaign_id,
      },
    });

    logger.info(`Contact ${contactId} enrolled in sequence ${sequenceId} → enrollment ${enrollment.id}`);

    res.status(200).json({
      success: true,
      enrollment,
      smartlead_lead_id:     smartleadLeadId,
      smartlead_campaign_id: sequence.smartlead_campaign_id,
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    logger.error(`Failed to enroll contact ${contactId}`, error);

    if (error.code === 'SMARTLEAD_NOT_CONNECTED') {
      res.status(401).json({ error: 'Sequence owner has not connected their Smartlead account' });
      return;
    }

    if (error.message?.includes('not found') || error.message?.includes('No rows')) {
      res.status(404).json({ error: 'Resource not found', details: error.message });
      return;
    }

    res.status(500).json({ error: 'Failed to enroll contact', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/enrollments/:id/pause
// Marks enrollment as paused in our DB.
// Note: Smartlead does not support pausing individual leads —
// we track this locally and skip leads with status='paused' in future logic.
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

    res.status(200).json({
      success: true,
      enrollmentId,
      status: 'paused',
      note: 'Tracked in OutboundHQ only — Smartlead will continue sending until the sequence completes.',
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to pause enrollment ${enrollmentId}`, error);
    res.status(500).json({ error: 'Failed to pause enrollment', details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/enrollments/:id/resume
// Resumes a paused enrollment.
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

    res.status(200).json({
      success: true,
      enrollmentId,
      status: 'active',
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to resume enrollment ${enrollmentId}`, error);
    res.status(500).json({ error: 'Failed to resume enrollment', details: error.message });
  }
});

export default router;
