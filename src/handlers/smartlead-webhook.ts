import { Request, Response } from 'express';
import {
  findEnrollmentBySmartleadId,
  logEngagement,
  updateContactEngagementScore,
  updateEnrollmentStatus,
  markContactEmailInvalid,
  markContactUnsubscribed,
  type Enrollment,
} from '../services/supabase';
import { createLogger } from '../utils/logger';

const logger = createLogger('SmartleadWebhook');

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface SmartleadEvent {
  event_type:  string;
  lead_id:     string | number;  // Smartlead sends this as a JSON number
  campaign_id?: string | number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────

export async function handleSmartleadWebhook(req: Request, res: Response): Promise<void> {
  try {
    const event = req.body as SmartleadEvent;

    logger.info(`Received Smartlead webhook: ${event.event_type}`, {
      lead_id:    event.lead_id,
      campaign_id: event.campaign_id,
    });

    // Smartlead sends UPPER_SNAKE_CASE; normalise to our internal dot-format
    // so both live webhooks and any future format changes are handled.
    const normalised = normaliseEventType(event.event_type);
    logger.debug(`Normalised event type: ${event.event_type} → ${normalised}`);

    switch (normalised) {
      case 'email.sent':
        await handleEmailSent(event);
        break;
      case 'email.opened':
        await handleEmailOpened(event);
        break;
      case 'email.clicked':
        await handleEmailClicked(event);
        break;
      case 'email.replied':
        await handleEmailReplied(event);
        break;
      case 'email.bounced':
        await handleEmailBounced(event);
        break;
      case 'email.unsubscribed':
        await handleUnsubscribed(event);
        break;
      default:
        logger.warn(`Unknown event type: ${event.event_type} (normalised: ${normalised})`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Webhook processing failed', error);
    // Always return 200 to Smartlead to prevent retries for non-transient errors.
    // Log the failure internally instead.
    res.status(200).json({ success: false, error: 'Internal processing error' });
  }
}

// ─────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────

async function handleEmailSent(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await logEngagement({
    contactId:      enrollment.contact_id,
    sequenceId:     enrollment.sequence_id,
    enrollmentId:   enrollment.id,
    engagementType: 'email_sent',
    metadata:       sanitiseEvent(event),
  });

  logger.info(`email_sent logged for enrollment ${enrollment.id}`);
}

async function handleEmailOpened(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_opened',
      metadata:       sanitiseEvent(event),
    }),
    updateContactEngagementScore(enrollment.contact_id, 10),
  ]);

  logger.info(`email_opened logged (+10 pts) for enrollment ${enrollment.id}`);
}

async function handleEmailClicked(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_clicked',
      metadata:       sanitiseEvent(event),
    }),
    updateContactEngagementScore(enrollment.contact_id, 15),
  ]);

  logger.info(`email_clicked logged (+15 pts) for enrollment ${enrollment.id}`);
}

async function handleEmailReplied(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_replied',
      metadata:       sanitiseEvent(event),
    }),
    updateContactEngagementScore(enrollment.contact_id, 50),
    updateEnrollmentStatus(enrollment.id, 'completed'),
  ]);

  // TODO: Create a follow-up task for the SDR
  logger.info(`email_replied logged (+50 pts, enrollment completed) for enrollment ${enrollment.id}`);
}

async function handleEmailBounced(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await Promise.all([
    logEngagement({
      contactId:      enrollment.contact_id,
      sequenceId:     enrollment.sequence_id,
      enrollmentId:   enrollment.id,
      engagementType: 'email_bounced',
      metadata:       sanitiseEvent(event),
    }),
    updateEnrollmentStatus(enrollment.id, 'bounced'),
    markContactEmailInvalid(enrollment.contact_id),
  ]);

  logger.info(`email_bounced logged (enrollment bounced) for enrollment ${enrollment.id}`);
}

async function handleUnsubscribed(event: SmartleadEvent): Promise<void> {
  const enrollment = await requireEnrollment(event.lead_id);
  if (!enrollment) return;

  await Promise.all([
    updateEnrollmentStatus(enrollment.id, 'unsubscribed'),
    markContactUnsubscribed(enrollment.contact_id),
  ]);

  logger.info(`Unsubscribed: enrollment ${enrollment.id} marked, contact ${enrollment.contact_id} flagged`);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Fetch enrollment or log a warning and return null (non-fatal). */
async function requireEnrollment(leadId: string | number): Promise<Enrollment | null> {
  if (!leadId) {
    logger.warn('Webhook received with no lead_id – skipping');
    return null;
  }

  // Smartlead sends lead_id as a JSON number; coerce to string for DB lookup
  const enrollment = await findEnrollmentBySmartleadId(String(leadId));
  if (!enrollment) {
    logger.warn(`No enrollment found for Smartlead lead ID: ${leadId}`);
    return null;
  }

  return enrollment;
}

/**
 * Map Smartlead's actual webhook event names to our internal dot-format.
 * Smartlead docs use UPPER_SNAKE_CASE; older/future formats may differ.
 * Any unrecognised type passes through as-is (the switch default will warn).
 */
function normaliseEventType(raw: string): string {
  const map: Record<string, string> = {
    // Smartlead's documented event names
    EMAIL_SENT:        'email.sent',
    EMAIL_OPEN:        'email.opened',
    EMAIL_LINK_CLICK:  'email.clicked',
    EMAIL_REPLY:       'email.replied',
    EMAIL_BOUNCE:      'email.bounced',
    UNSUBSCRIBE:       'email.unsubscribed',
    // Already-normalised variants (belt-and-suspenders)
    'email.sent':        'email.sent',
    'email.opened':      'email.opened',
    'email.clicked':     'email.clicked',
    'email.replied':     'email.replied',
    'email.bounced':     'email.bounced',
    'email.unsubscribed':'email.unsubscribed',
  };
  return map[raw] ?? raw;
}

/** Strip any potentially large/sensitive fields before storing as metadata. */
function sanitiseEvent(event: SmartleadEvent): Record<string, unknown> {
  const { event_type, lead_id, campaign_id, ...rest } = event;
  return { event_type, lead_id, campaign_id, ...rest };
}
