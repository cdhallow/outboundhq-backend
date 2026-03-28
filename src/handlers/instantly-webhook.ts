import { Request, Response } from 'express';
import {
  supabase,
  findEnrollmentByInstantly,
  logEngagement,
  logEmailMessage,
  updateEnrollmentStatus,
  updateContactEngagementScore,
  markContactEmailInvalid,
  markContactUnsubscribedAt,
} from '../services/supabase';
import { createLogger } from '../utils/logger';

const logger = createLogger('InstantlyWebhook');

// ─────────────────────────────────────────────
// Instantly webhook payload shape (flexible — extra fields ignored)
// ─────────────────────────────────────────────

interface InstantlyEvent {
  event_type:          string;
  campaign_id?:        string;
  campaign_name?:      string;
  // Lead/contact identification
  lead_email?:         string;
  email?:              string;        // fallback alias used in some events
  email_account?:      string;        // sending account
  // Reply-specific fields (V2 spec)
  email_id?:           string;        // message ID
  email_subject?:      string;        // original email subject
  reply_subject?:      string;        // subject of the reply
  reply_text?:         string;        // plain-text reply body
  reply_html?:         string;        // HTML reply body
  reply_text_snippet?: string;        // short preview
  thread_id?:          string;
  timestamp?:          string;
  // Step info
  step?:               number;
  variant?:            number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// Main handler — POST /webhooks/instantly
// ─────────────────────────────────────────────

export async function handleInstantlyWebhook(req: Request, res: Response): Promise<void> {
  try {
    const event = req.body as InstantlyEvent;

    logger.info(`Instantly webhook: ${event.event_type}`, {
      campaign_id: event.campaign_id,
      lead_email:  event.lead_email ?? event.email,
    });

    switch (event.event_type) {
      case 'reply_received':
        await handleReplyReceived(event);
        break;
      case 'email_opened':
        await handleEmailOpened(event);
        break;
      case 'email_clicked':   // legacy alias
      case 'link_clicked':    // V2 canonical name
        await handleEmailClicked(event);
        break;
      case 'email_sent':
        await handleEmailSent(event);
        break;
      case 'email_bounced':
        await handleEmailBounced(event);
        break;
      case 'lead_unsubscribed':
        await handleLeadUnsubscribed(event);
        break;
      case 'lead_interested':
        await handleLeadInterested(event);
        break;
      case 'campaign_completed':
      case 'campaign_completed_for_lead_without_reply':
        await handleCampaignCompleted(event);
        break;
      default:
        logger.warn(`Unhandled Instantly event type: ${event.event_type}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Instantly webhook processing failed', error);
    // Always 200 to prevent Instantly retries for non-transient errors
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
}

// ─────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────

async function handleReplyReceived(event: InstantlyEvent): Promise<void> {
  const leadEmail  = normaliseEmail(event.lead_email ?? event.email ?? '');
  const campaignId = event.campaign_id ?? '';

  if (!leadEmail || !campaignId) {
    logger.warn('reply_received missing lead email or campaign_id — skipping');
    return;
  }

  const enrollment = await findEnrollmentByInstantly(campaignId, leadEmail);
  if (!enrollment) {
    logger.warn(`No enrollment for reply_received: campaign ${campaignId} / ${leadEmail}`);
    // Still store the message even without a matched enrollment
  }

  // Store the inbound message for conversation threading
  // V2 field names: reply_text, reply_html, reply_subject, email_id
  await logEmailMessage({
    contactId:            enrollment?.contact_id  ?? await findOrSkipContactId(leadEmail),
    enrollmentId:         enrollment?.id          ?? null,
    sequenceId:           enrollment?.sequence_id ?? null,
    direction:            'inbound',
    subject:              event.reply_subject ?? event.email_subject ?? null,
    bodyText:             event.reply_text    ?? null,
    bodyHtml:             event.reply_html    ?? null,
    fromAddress:          leadEmail,
    toAddress:            event.email_account ?? null,
    instantlyMessageId:   event.email_id      ?? null,
    instantlyCampaignId:  campaignId,
    threadId:             event.thread_id     ?? null,
    status:               'pending_review',
    receivedAt:           event.timestamp     ?? new Date().toISOString(),
  });

  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_replied',
      metadata:       {
        instantly_message_id:  event.email_id,
        instantly_campaign_id: campaignId,
        subject:               event.reply_subject ?? event.email_subject,
        thread_id:             event.thread_id,
      },
    }),
    updateContactEngagementScore(enrollment.contact_id, 50),
    updateEnrollmentStatus(enrollment.id, 'paused'),
    updateContactLeadTier(enrollment.contact_id),
  ]);

  logger.info(
    `reply_received: enrollment ${enrollment.id} paused, +50 pts, message stored`
  );
}

async function handleEmailOpened(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_opened',
      metadata:       sanitise(event),
    }),
    updateContactEngagementScore(enrollment.contact_id, 10),
  ]);

  logger.info(`email_opened: +10 pts for enrollment ${enrollment.id}`);
}

async function handleEmailClicked(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_clicked',
      metadata:       sanitise(event),
    }),
    updateContactEngagementScore(enrollment.contact_id, 15),
  ]);

  logger.info(`email_clicked: +15 pts for enrollment ${enrollment.id}`);
}

async function handleEmailBounced(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_bounced',
      metadata:       sanitise(event),
    }),
    updateEnrollmentStatus(enrollment.id, 'bounced'),
    markContactEmailInvalid(enrollment.contact_id),
  ]);

  logger.info(`email_bounced: enrollment ${enrollment.id} bounced, contact flagged`);
}

async function handleEmailSent(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await logEngagement({
    contactId:      enrollment.contact_id,
    sequenceId:     enrollment.sequence_id,
    enrollmentId:   enrollment.id,
    engagementType: 'email_sent',
    metadata:       sanitise(event),
  });

  logger.info(`email_sent: logged for enrollment ${enrollment.id}`);
}

async function handleLeadInterested(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_replied',
      metadata:       { ...sanitise(event), instantly_classification: 'interested' },
    }),
    updateContactEngagementScore(enrollment.contact_id, 50),
    updateContactLeadTier(enrollment.contact_id),
  ]);

  logger.info(`lead_interested: +50 pts, contact marked hot for enrollment ${enrollment.id}`);
}

async function handleCampaignCompleted(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await updateEnrollmentStatus(enrollment.id, 'completed');

  logger.info(`campaign_completed: enrollment ${enrollment.id} marked completed`);
}

async function handleLeadUnsubscribed(event: InstantlyEvent): Promise<void> {
  const enrollment = await requireEnrollment(event);
  if (!enrollment) return;

  await Promise.all([
    updateEnrollmentStatus(enrollment.id, 'unsubscribed'),
    markContactUnsubscribedAt(enrollment.contact_id),
  ]);

  logger.info(`lead_unsubscribed: enrollment ${enrollment.id}, contact ${enrollment.contact_id} flagged`);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function requireEnrollment(event: InstantlyEvent) {
  const leadEmail  = normaliseEmail(event.lead_email ?? event.email ?? '');
  const campaignId = event.campaign_id ?? '';

  if (!leadEmail || !campaignId) {
    logger.warn(`${event.event_type}: missing lead email or campaign_id — skipping`);
    return null;
  }

  const enrollment = await findEnrollmentByInstantly(campaignId, leadEmail);
  if (!enrollment) {
    logger.warn(`${event.event_type}: no enrollment for campaign ${campaignId} / ${leadEmail}`);
  }
  return enrollment;
}

/** Look up contact ID by email — returns empty string if not found (non-fatal). */
async function findOrSkipContactId(email: string): Promise<string> {
  const { data } = await supabase
    .from('contacts')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  return data?.id ?? '';
}

/** Upgrade contact lead_tier when they reply (signal of high intent). */
async function updateContactLeadTier(contactId: string): Promise<void> {
  await supabase
    .from('contacts')
    .update({ lead_tier: 'hot' } as Record<string, unknown>)
    .eq('id', contactId);
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sanitise(event: InstantlyEvent): Record<string, unknown> {
  const { event_type, campaign_id, lead_email, email } = event;
  return { event_type, campaign_id, lead_email: lead_email ?? email };
}
