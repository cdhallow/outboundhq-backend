import express from 'express';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { executeSequences } from './cron/sequence-executor';
import { handleSmartleadWebhook } from './handlers/smartlead-webhook';
import { createLogger } from './utils/logger';

// Load environment variables
dotenv.config();

const logger = createLogger('Server');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// Smartlead webhook endpoint
app.post('/webhooks/smartlead', handleSmartleadWebhook);

// Manual trigger for sequence execution (for testing)
app.post('/cron/execute-sequences', async (req, res) => {
  try {
    logger.info('Manual sequence execution triggered');
    await executeSequences();
    res.json({
      success: true,
      message: 'Sequences executed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Manual execution failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Schedule cron job - runs every 15 minutes
// Cron pattern: */15 * * * * = every 15 minutes
cron.schedule('*/15 * * * *', () => {
  logger.info('Cron job triggered');
  executeSequences();
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📧 Sequence cron job scheduled (every 15 minutes)`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Log environment variable status
  const envVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SMARTLEAD_API_KEY',
    'SMARTLEAD_EMAIL_ACCOUNT_ID',
  ];
  
  envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      logger.info(`✓ ${varName} configured`);
    } else {
      logger.warn(`✗ ${varName} missing`);
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
