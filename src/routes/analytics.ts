import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('AnalyticsRoute');

// ─────────────────────────────────────────────
// GET /api/analytics/overview
// Aggregated stats across email (Instantly) + calls (Twilio).
// Optionally filter by userId or date range.
// ─────────────────────────────────────────────

router.get('/overview', async (req: Request, res: Response): Promise<void> => {
  const { userId, from, to } = req.query as {
    userId?: string;
    from?:   string;   // ISO date string
    to?:     string;
  };

  logger.info('Fetching analytics overview', { userId, from, to });

  try {
    // ── Call stats from Supabase ──────────────────────────────────────────
    let callQuery = supabase
      .from('calls')
      .select('status, duration_seconds, outcome');

    if (userId) callQuery = callQuery.eq('user_id', userId);
    if (from)   callQuery = callQuery.gte('started_at', from);
    if (to)     callQuery = callQuery.lte('started_at', to);

    const { data: calls, error: callError } = await callQuery;
    if (callError) throw callError;

    const callStats = {
      total:       calls?.length ?? 0,
      connected:   calls?.filter((c) => c.status === 'completed').length ?? 0,
      no_answer:   calls?.filter((c) => c.status === 'no_answer').length ?? 0,
      busy:        calls?.filter((c) => c.status === 'busy').length ?? 0,
      failed:      calls?.filter((c) => c.status === 'failed').length ?? 0,
      avg_duration_seconds: calls?.length
        ? Math.round(
            (calls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0)) / calls.length
          )
        : 0,
    };

    // ── Engagement stats from Supabase ────────────────────────────────────
    let engagementQuery = supabase
      .from('engagements')
      .select('engagement_type');

    if (from) engagementQuery = engagementQuery.gte('engaged_at', from);
    if (to)   engagementQuery = engagementQuery.lte('engaged_at', to);

    const { data: engagements, error: engError } = await engagementQuery;
    if (engError) throw engError;

    const engagementStats = {
      email_sent:    engagements?.filter((e) => e.engagement_type === 'email_sent').length    ?? 0,
      email_opened:  engagements?.filter((e) => e.engagement_type === 'email_opened').length  ?? 0,
      email_clicked: engagements?.filter((e) => e.engagement_type === 'email_clicked').length ?? 0,
      email_replied: engagements?.filter((e) => e.engagement_type === 'email_replied').length ?? 0,
      email_bounced: engagements?.filter((e) => e.engagement_type === 'email_bounced').length ?? 0,
    };

    // Compute rates (avoid divide-by-zero)
    const sent = engagementStats.email_sent || 1;
    const rates = {
      open_rate:    parseFloat(((engagementStats.email_opened  / sent) * 100).toFixed(1)),
      click_rate:   parseFloat(((engagementStats.email_clicked / sent) * 100).toFixed(1)),
      reply_rate:   parseFloat(((engagementStats.email_replied / sent) * 100).toFixed(1)),
      bounce_rate:  parseFloat(((engagementStats.email_bounced / sent) * 100).toFixed(1)),
    };

    // ── Active enrollments ────────────────────────────────────────────────
    const { count: activeEnrollments } = await supabase
      .from('sequence_enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    // ── Hot leads (replied) ───────────────────────────────────────────────
    const { count: hotLeads } = await supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('lead_tier', 'hot');

    // ── Instantly campaign-level stats from our own engagements table ────────
    // (Instantly V2 API does not expose a /campaigns/{id}/analytics endpoint)
    let instantlyCampaignStats = null;
    try {
      const { data: engRows } = await supabase
        .from('engagements')
        .select('engagement_type');

      if (engRows) {
        instantlyCampaignStats = {
          sent:    engRows.filter((e) => e.engagement_type === 'email_sent').length,
          opened:  engRows.filter((e) => e.engagement_type === 'email_opened').length,
          clicked: engRows.filter((e) => e.engagement_type === 'email_clicked').length,
          replied: engRows.filter((e) => e.engagement_type === 'email_replied').length,
        };
      }
    } catch (campaignErr) {
      logger.warn('Could not fetch campaign analytics from engagements table', campaignErr);
    }

    res.status(200).json({
      calls:       callStats,
      email:       { ...engagementStats, rates },
      enrollments: { active: activeEnrollments ?? 0 },
      leads:       { hot: hotLeads ?? 0 },
      instantly:   instantlyCampaignStats,  // null if no active campaigns
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Failed to fetch analytics overview', error);
    res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/analytics/calls
// Detailed call analytics — by outcome, by SDR, over time.
// ─────────────────────────────────────────────

router.get('/calls', async (req: Request, res: Response): Promise<void> => {
  const { userId, from, to } = req.query as { userId?: string; from?: string; to?: string };

  try {
    let query = supabase
      .from('calls')
      .select('id, status, outcome, duration_seconds, started_at, ended_at, user_id, recording_url, transcript');

    if (userId) query = query.eq('user_id', userId);
    if (from)   query = query.gte('started_at', from);
    if (to)     query = query.lte('started_at', to);

    const { data, error } = await query.order('started_at', { ascending: false });
    if (error) throw error;

    // Add boolean convenience flags so the frontend doesn't need to null-check URLs
    const calls = (data ?? []).map((c) => ({
      ...c,
      has_recording:  c.recording_url !== null,
      has_transcript: c.transcript    !== null,
    }));

    res.status(200).json({ calls });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Failed to fetch call analytics', error);
    res.status(500).json({ error: 'Failed to fetch call analytics', details: error.message });
  }
});

export default router;
