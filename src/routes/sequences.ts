import { Router, Request, Response } from 'express';
import {
  getSequenceWithSteps,
  getUserProfile,
  updateSequenceInstantlyCampaignId,
  getLocalEngagementCounts,
} from '../services/supabase';
import {
  createCampaign,
  resumeCampaign,
  getCampaignAnalytics,
  listEmailAccounts,
} from '../services/instantly';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('SequencesRoute');

// ─────────────────────────────────────────────
// POST /api/sequences/:id/activate
// Creates an Instantly campaign from the sequence and marks it active.
// ─────────────────────────────────────────────

router.post('/:id/activate', async (req: Request, res: Response): Promise<void> => {
  const { id: sequenceId } = req.params;

  const userId: string | undefined =
    (req.body as Record<string, string>)?.userId ??
    (req.query.userId as string | undefined);

  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  logger.info(`Activate request for sequence ${sequenceId} by user ${userId}`);

  try {
    // 1. Fetch sequence + steps
    const sequence = await getSequenceWithSteps(sequenceId);

    if (!sequence) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    // 2. Guard: already activated via Instantly
    if (sequence.status === 'active' && sequence.instantly_campaign_id) {
      res.status(409).json({
        error: 'Sequence is already active',
        instantly_campaign_id: sequence.instantly_campaign_id,
      });
      return;
    }

    // 3. Fetch the SDR's profile for from_name / reply_to
    //    Inbox is no longer required here — it is selected at enrollment time.
    const profile  = await getUserProfile(userId);
    const fromName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'OutboundHQ';
    const replyTo  = profile.email ?? '';

    // 4. Filter to email steps only, ordered by step_number
    const emailSteps = (sequence.sequence_steps ?? [])
      .filter((s) => s.step_type === 'email')
      .sort((a, b) => a.step_number - b.step_number);

    if (emailSteps.length === 0) {
      res.status(400).json({ error: 'Sequence has no email steps to activate' });
      return;
    }

    // 5. Build step payload
    const steps = emailSteps.map((step) => ({
      step_number: step.step_number,
      subject:     step.subject ?? '',
      body:        step.body    ?? '',
      delay_days:  step.delay_days ?? 0,
    }));

    // 6. Create Instantly campaign — all workspace inboxes attached automatically
    const campaignId = await createCampaign({
      id:       sequence.id,
      name:     sequence.name,
      steps,
      fromName,
      replyTo,
    });

    // 7. Persist campaign ID + status in Supabase
    await updateSequenceInstantlyCampaignId(sequenceId, campaignId);

    // 8. Launch the campaign in Instantly so it's ready to send when leads are added
    await resumeCampaign(campaignId);

    logger.info(`Sequence ${sequenceId} activated → Instantly campaign ${campaignId}`);

    res.status(200).json({
      success: true,
      sequenceId,
      instantly_campaign_id: campaignId,
      status: 'active',
      email_steps_count:  emailSteps.length,
      skipped_call_steps: (sequence.sequence_steps ?? []).length - emailSteps.length,
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to activate sequence ${sequenceId}`, error);

    if (error.message?.includes('not found') || error.message?.includes('No rows')) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    res.status(500).json({ error: 'Failed to activate sequence', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/sequences/:id/stats
// Returns merged stats from Instantly + local engagements table.
// ─────────────────────────────────────────────

router.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
  const { id: sequenceId } = req.params;

  logger.info(`Stats request for sequence ${sequenceId}`);

  try {
    const sequence = await getSequenceWithSteps(sequenceId);

    if (!sequence) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    if (!sequence.instantly_campaign_id) {
      res.status(400).json({ error: 'Sequence has not been activated yet' });
      return;
    }

    const [instantlyStats, localCounts] = await Promise.all([
      getCampaignAnalytics(sequence.instantly_campaign_id),
      getLocalEngagementCounts(sequenceId),
    ]);

    res.status(200).json({
      sequenceId,
      instantly_campaign_id: sequence.instantly_campaign_id,
      status: sequence.status,
      instantly: instantlyStats,
      local:     localCounts,
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to fetch stats for sequence ${sequenceId}`, error);
    res.status(500).json({ error: 'Failed to fetch sequence stats', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/sequences/email-accounts
// Lists Instantly email accounts available in this workspace.
// Lovable uses this to populate the inbox picker in SDR settings.
// ─────────────────────────────────────────────

router.get('/email-accounts', async (_req: Request, res: Response): Promise<void> => {
  try {
    const accounts = await listEmailAccounts();
    res.status(200).json({ accounts });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Failed to list Instantly email accounts', error);
    res.status(500).json({ error: 'Failed to fetch email accounts', details: error.message });
  }
});

export default router;
