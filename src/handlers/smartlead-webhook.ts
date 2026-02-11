import { Request, Response } from 'express';
import { logEngagement, updateContactScore } from '../services/supabase';
import { createLogger } from '../utils/logger';

const logger = createLogger('SmartleadWebhook');

export async function handleSmartleadWebhook(req: Request, res: Response) {
  try {
    const event = req.body;

    logger.info(`Received Smartlead event: ${event.type}`);

    // Smartlead webhook event types
    switch (event.type) {
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
      default:
        logger.warn(`Unknown event type: ${event.type}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error processing webhook', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleEmailOpened(event: any) {
  try {
    await logEngagement({
      contact_id: event.contact_id,
      sequence_id: event.sequence_id,
      enrollment_id: event.enrollment_id,
      engagement_type: 'email_opened',
      metadata: event,
    });

    // Update contact score (+10 points)
    await updateContactScore(event.contact_id, 10);

    logger.info(`Email opened: ${event.contact_id}`);
  } catch (error) {
    logger.error('Error handling email opened event', error);
  }
}

async function handleEmailClicked(event: any) {
  try {
    await logEngagement({
      contact_id: event.contact_id,
      sequence_id: event.sequence_id,
      enrollment_id: event.enrollment_id,
      engagement_type: 'email_clicked',
      metadata: event,
    });

    // Update contact score (+15 points)
    await updateContactScore(event.contact_id, 15);

    logger.info(`Email link clicked: ${event.contact_id}`);
  } catch (error) {
    logger.error('Error handling email clicked event', error);
  }
}

async function handleEmailReplied(event: any) {
  try {
    await logEngagement({
      contact_id: event.contact_id,
      sequence_id: event.sequence_id,
      enrollment_id: event.enrollment_id,
      engagement_type: 'email_replied',
      metadata: event,
    });

    // Update contact score (+50 points)
    await updateContactScore(event.contact_id, 50);

    logger.info(`Email reply received: ${event.contact_id}`);

    // TODO: Implement auto-pause enrollment logic
    // When someone replies, we might want to pause their sequence
  } catch (error) {
    logger.error('Error handling email replied event', error);
  }
}

async function handleEmailBounced(event: any) {
  try {
    await logEngagement({
      contact_id: event.contact_id,
      sequence_id: event.sequence_id,
      enrollment_id: event.enrollment_id,
      engagement_type: 'email_bounced',
      metadata: event,
    });

    logger.warn(`Email bounced: ${event.contact_id}`);

    // TODO: Mark contact email as invalid
    // TODO: Pause enrollment
  } catch (error) {
    logger.error('Error handling email bounced event', error);
  }
}
