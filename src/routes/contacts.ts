import { Router, Request, Response } from 'express';
import { getContactMessages } from '../services/supabase';
import { createLogger } from '../utils/logger';

const router = Router();
const logger = createLogger('ContactsRoute');

// ─────────────────────────────────────────────
// GET /api/contacts/:id/messages
// Paginated email conversation thread for a contact.
// ─────────────────────────────────────────────

router.get('/:id/messages', async (req: Request, res: Response): Promise<void> => {
  const { id: contactId } = req.params;

  const limit  = Math.min(parseInt((req.query.limit  as string) || '50', 10), 200);
  const offset = Math.max(parseInt((req.query.offset as string) || '0',  10), 0);

  logger.info(`Messages request for contact ${contactId} (limit=${limit} offset=${offset})`);

  try {
    const { messages, total } = await getContactMessages(contactId, limit, offset);

    res.status(200).json({ messages, total });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Failed to fetch messages for contact ${contactId}`, error);
    res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

export default router;
