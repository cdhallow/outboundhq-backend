import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

import sequencesRouter from './routes/sequences';
import enrollmentsRouter from './routes/enrollments';
import callsRouter from './routes/calls';
import contactsRouter from './routes/contacts';
import { handleInstantlyWebhook } from './handlers/instantly-webhook';
import { handleCallStatus, handleRecording } from './handlers/twilio-webhooks';
import { createLogger } from './utils/logger';

const logger = createLogger('Server');
const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(cors());
app.use(express.json());
// Twilio webhooks POST as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Request logging in non-production environments
if (process.env.NODE_ENV !== 'production') {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, { body: req.body, query: req.query });
    next();
  });
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Health check — Railway uses this to verify the deployment is alive
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'outboundhq-backend',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api/sequences',   sequencesRouter);
app.use('/api/enrollments', enrollmentsRouter);
app.use('/api/calls',       callsRouter);
app.use('/api/contacts',    contactsRouter);

// Instantly webhooks
app.post('/webhooks/instantly', handleInstantlyWebhook);

// Twilio webhooks
app.post('/webhooks/twilio/status',    handleCallStatus);
app.post('/webhooks/twilio/recording', handleRecording);

// ─────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ─────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`OutboundHQ backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV ?? 'development'}`);

  if (!process.env.INSTANTLY_API_KEY) {
    logger.warn('INSTANTLY_API_KEY is not set — email campaign features will fail on first use');
  }
});

export default app;
