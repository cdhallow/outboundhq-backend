import { Router, Request, Response } from 'express';
import { sendEmailReply, listEmailAccounts } from '../services/instantly';
import { logEmailMessage, supabase } from '../services/supabase';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('EmailsRoute');

// ─────────────────────────────────────────────
// POST /api/emails/reply
// Send a reply to an inbound email from a contact.
// Stores the outbound reply in email_messages and sends via Instantly.
// ─────────────────────────────────────────────

router.post('/reply', async (req: Request, res: Response): Promise<void> => {
  const {
    contactId,
    enrollmentId,
    sequenceId,
    toAddress,
    fromAddress,   // sending inbox e.g. "cd@hallowpartnershipteam.com"
    subject,
    bodyText,
    bodyHtml,
    threadId,
    instantlyEmailId,  // email_id from the inbound email_messages row (reply_received webhook)
  } = req.body as {
    contactId:         string;
    enrollmentId?:     string;
    sequenceId?:       string;
    toAddress:         string;
    fromAddress?:      string;
    subject:           string;
    bodyText:          string;
    bodyHtml?:         string;
    threadId?:         string;
    instantlyEmailId?: string;
  };

  if (!contactId || !toAddress || !subject || !bodyText) {
    res.status(400).json({ error: 'contactId, toAddress, subject, and bodyText are required' });
    return;
  }

  if (!fromAddress) {
    res.status(400).json({ error: 'fromAddress (sending inbox) is required for Instantly replies' });
    return;
  }

  logger.info(`Reply request: contact=${contactId} to=${toAddress} from=${fromAddress}`);

  try {
    // 1. Send via Instantly's reply API — threads correctly in their unibox
    if (instantlyEmailId) {
      await sendEmailReply({
        replyToUuid: instantlyEmailId,
        eaccount:    fromAddress,
        subject,
        bodyText,
        bodyHtml,
      });
      logger.info(`Reply sent via Instantly for email ${instantlyEmailId}`);
    } else {
      logger.warn(`No instantlyEmailId provided — reply stored but not sent`);
    }

    // 2. Store the outbound reply in email_messages for conversation threading
    await logEmailMessage({
      contactId,
      enrollmentId:         enrollmentId   ?? null,
      sequenceId:           sequenceId     ?? null,
      direction:            'outbound',
      subject,
      bodyText,
      bodyHtml:             bodyHtml       ?? null,
      fromAddress:          fromAddress    ?? null,
      toAddress,
      threadId:             threadId       ?? null,
      instantlyCampaignId:  null,
      status:               'delivered',
      sentAt:               new Date().toISOString(),
    });

    logger.info(`Reply stored for contact ${contactId}`);
    res.status(200).json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to send reply for contact ${contactId}`, error);
    res.status(500).json({ error: 'Failed to send reply', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/emails/thread/:contactId
// Fetch the full email thread for a contact.
// ─────────────────────────────────────────────

router.get('/thread/:contactId', async (req: Request, res: Response): Promise<void> => {
  const { contactId } = req.params;

  try {
    const { data, error } = await supabase
      .from('email_messages')
      .select('*')
      .eq('contact_id', contactId)
      .order('sent_at', { ascending: true, nullsFirst: false });

    if (error) throw error;

    res.status(200).json({ messages: data ?? [] });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to fetch thread for contact ${contactId}`, error);
    res.status(500).json({ error: 'Failed to fetch email thread', details: error.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/emails/accounts
// List all Instantly sending inboxes so the frontend can populate a
// "Send from" dropdown in the reply composer.
// ─────────────────────────────────────────────

router.get('/accounts', async (_req: Request, res: Response): Promise<void> => {
  try {
    const accounts = await listEmailAccounts();
    res.status(200).json({ accounts });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Failed to fetch email accounts', error);
    res.status(500).json({ error: 'Failed to fetch email accounts', details: error.message });
  }
});

export default router;
