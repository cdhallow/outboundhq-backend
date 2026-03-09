import { Router, Request, Response } from 'express';
import {
  getSequenceWithSteps,
  getUserSmartleadCredentials,
  updateSequenceWithCampaignId,
  getLocalEngagementCounts,
} from '../services/supabase';
import {
  createCampaignFromSequence,
  getCampaignStats,
} from '../services/smartlead';
import { replaceVariables } from '../utils/variables';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('SequencesRoute');

// ─────────────────────────────────────────────
// POST /api/sequences/:id/activate
// Creates a Smartlead campaign from the sequence and marks it active.
// ─────────────────────────────────────────────

router.post('/:id/activate', async (req: Request, res: Response): Promise<void> => {
  const { id: sequenceId } = req.params;

  // The userId can come from a verified auth header in the future.
  // For now, accept it from the request body or a query param.
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

    // 2. Guard: already activated
    if (sequence.status === 'active' && sequence.smartlead_campaign_id) {
      res.status(409).json({
        error: 'Sequence is already active',
        smartlead_campaign_id: sequence.smartlead_campaign_id,
      });
      return;
    }

    // 3. Get user's Smartlead credentials
    const { apiKey, emailAccountId } = await getUserSmartleadCredentials(userId);

    // 4. Filter to email steps only, ordered by step_number
    const emailSteps = (sequence.sequence_steps ?? [])
      .filter((s) => s.step_type === 'email')
      .sort((a, b) => a.step_number - b.step_number);

    if (emailSteps.length === 0) {
      res.status(400).json({ error: 'Sequence has no email steps to activate' });
      return;
    }

    // 5. Build step payload (variables replaced with generic placeholders at campaign
    //    creation time; per-contact substitution happens at enrollment).
    const steps = emailSteps.map((step) => ({
      step_number: step.step_number,
      subject:     step.subject ?? '',
      body:        step.body    ?? '',
      delay_days:  step.delay_days ?? 0,
    }));

    // 6. Create Smartlead campaign
    const campaignId = await createCampaignFromSequence(apiKey, emailAccountId, {
      id:    sequence.id,
      name:  sequence.name,
      steps,
    });

    // 7. Persist campaign ID + status in Supabase
    await updateSequenceWithCampaignId(sequenceId, campaignId);

    logger.info(`Sequence ${sequenceId} activated → Smartlead campaign ${campaignId}`);

    res.status(200).json({
      success: true,
      sequenceId,
      smartlead_campaign_id: campaignId,
      status: 'active',
      email_steps_count: emailSteps.length,
      skipped_call_steps: (sequence.sequence_steps ?? []).length - emailSteps.length,
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    logger.error(`Failed to activate sequence ${sequenceId}`, error);

    if (error.code === 'SMARTLEAD_NOT_CONNECTED') {
      res.status(401).json({ error: 'User has not connected their Smartlead account' });
      return;
    }

    if (error.message?.includes('not found') || error.message?.includes('No rows')) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    res.status(500).json({ error: 'Failed to activate sequence', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/sequences/:id/stats
// Returns merged stats from Smartlead + local engagements table.
// ─────────────────────────────────────────────

router.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
  const { id: sequenceId } = req.params;

  const userId: string | undefined =
    (req.query.userId as string | undefined) ??
    (req.body as Record<string, string>)?.userId;

  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  logger.info(`Stats request for sequence ${sequenceId}`);

  try {
    // 1. Fetch sequence to get the campaign ID
    const sequence = await getSequenceWithSteps(sequenceId);

    if (!sequence) {
      res.status(404).json({ error: 'Sequence not found' });
      return;
    }

    if (!sequence.smartlead_campaign_id) {
      res.status(400).json({ error: 'Sequence has not been activated yet' });
      return;
    }

    // 2. Credentials
    const { apiKey } = await getUserSmartleadCredentials(userId);

    // 3. Fetch stats from Smartlead + local engagements in parallel
    const [smartleadStats, localCounts] = await Promise.all([
      getCampaignStats(apiKey, sequence.smartlead_campaign_id),
      getLocalEngagementCounts(sequenceId),
    ]);

    res.status(200).json({
      sequenceId,
      smartlead_campaign_id: sequence.smartlead_campaign_id,
      status: sequence.status,
      // Smartlead is the source of truth for delivery stats
      smartlead: smartleadStats,
      // Our engagements table for internal tracking / UI
      local: localCounts,
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    logger.error(`Failed to fetch stats for sequence ${sequenceId}`, error);

    if (error.code === 'SMARTLEAD_NOT_CONNECTED') {
      res.status(401).json({ error: 'User has not connected their Smartlead account' });
      return;
    }

    res.status(500).json({ error: 'Failed to fetch sequence stats', details: error.message });
  }
});

export default router;
