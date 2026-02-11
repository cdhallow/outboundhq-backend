# OutboundHQ Backend - Sequence Execution Engine

Backend service for OutboundHQ that handles sequence execution, Smartlead integration, and engagement tracking.

## Features

- ✅ **Sequence Execution** - Cron job runs every 15 minutes to process enrollments
- ✅ **Smartlead Integration** - Creates campaigns and adds leads
- ✅ **Engagement Tracking** - Receives webhooks for opens, clicks, replies
- ✅ **Variable Replacement** - Personalizes emails with {{firstName}}, etc.
- ✅ **Engagement Scoring** - Auto-updates contact scores
- ✅ **Call Task Creation** - Creates tasks for SDRs when call steps are reached

## Project Structure

```
outboundhq-backend/
├── src/
│   ├── index.ts                     # Express server + cron scheduler
│   ├── cron/
│   │   └── sequence-executor.ts     # Main sequence execution logic
│   ├── services/
│   │   ├── supabase.ts              # Supabase client + helpers
│   │   └── smartlead.ts             # Smartlead API client
│   ├── handlers/
│   │   └── smartlead-webhook.ts     # Webhook event handlers
│   └── utils/
│       ├── variables.ts             # Variable replacement
│       └── logger.ts                # Logging utility
├── package.json
├── tsconfig.json
└── .env.example
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Smartlead
SMARTLEAD_API_KEY=your-api-key
SMARTLEAD_EMAIL_ACCOUNT_ID=your-email-account-id

# Server
PORT=3000
NODE_ENV=production
```

### 3. Development

```bash
npm run dev
```

This starts the server with hot-reload enabled.

### 4. Build for Production

```bash
npm run build
npm start
```

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial backend setup"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your `outboundhq-backend` repository
5. Railway will auto-detect Node.js and deploy

### 3. Add Environment Variables in Railway

In your Railway project:

1. Go to **Variables** tab
2. Add each environment variable:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SMARTLEAD_API_KEY`
   - `SMARTLEAD_EMAIL_ACCOUNT_ID`
   - `NODE_ENV` = `production`

### 4. Configure Smartlead Webhook

In your Smartlead dashboard:

1. Go to **Settings → Webhooks**
2. Add webhook URL: `https://your-railway-app.railway.app/webhooks/smartlead`
3. Select events:
   - `email.opened`
   - `email.clicked`
   - `email.replied`
   - `email.bounced`
4. Save

## API Endpoints

### Health Check
```
GET /health
```

Returns server status and uptime.

### Smartlead Webhook
```
POST /webhooks/smartlead
```

Receives engagement events from Smartlead.

### Manual Sequence Execution (Testing)
```
POST /cron/execute-sequences
```

Manually triggers sequence execution (useful for testing).

## Testing

### Test Manual Execution

```bash
curl -X POST https://your-railway-app.railway.app/cron/execute-sequences
```

Expected response:
```json
{
  "success": true,
  "message": "Sequences executed successfully",
  "timestamp": "2026-01-22T..."
}
```

### Test Webhook

```bash
curl -X POST https://your-railway-app.railway.app/webhooks/smartlead \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email.opened",
    "contact_id": "test-contact-id",
    "sequence_id": "test-sequence-id",
    "enrollment_id": "test-enrollment-id"
  }'
```

### View Logs

In Railway:
1. Go to your project
2. Click on the service
3. Go to **Deployments** tab
4. Click **View Logs**

## How It Works

### Sequence Execution Flow

1. **Cron job runs** every 15 minutes
2. **Query enrollments** where `next_send_at <= NOW()` and `status = 'active'`
3. **For each enrollment:**
   - Check if step conditions are met (e.g., previous email opened)
   - If **email step**: Add contact to Smartlead campaign
   - If **call step**: Create call task in database
   - Log engagement (email sent)
   - Calculate next send time based on delay
   - Update enrollment to next step

4. **When sequence completes:**
   - Mark enrollment as `completed`
   - Set `completed_at` timestamp

### Engagement Tracking Flow

1. **Smartlead sends webhook** when email opened/clicked/replied
2. **Webhook handler:**
   - Logs engagement to `engagements` table
   - Updates contact `engagement_score`
   - (Future: Pause enrollment if replied)

### Engagement Scoring

- **Email opened:** +10 points
- **Link clicked:** +15 points
- **Email replied:** +50 points

## Troubleshooting

### Cron not running

- Check Railway logs for errors
- Verify cron pattern: `*/15 * * * *` = every 15 minutes
- Test manually via `/cron/execute-sequences` endpoint

### Smartlead API errors

- Verify `SMARTLEAD_API_KEY` is correct
- Check Smartlead dashboard for rate limits
- Review Smartlead docs: https://smartlead.ai/docs

### Webhook not receiving events

- Check Smartlead webhook configuration
- Verify Railway URL is publicly accessible
- Check Railway logs for incoming requests
- Test with manual curl command

### Database errors

- Verify `SUPABASE_SERVICE_ROLE_KEY` (not anon key!)
- Check RLS policies allow service role to read/write
- Review Supabase logs

## Next Steps

- [ ] Test end-to-end flow with real sequence
- [ ] Monitor engagement data in Supabase
- [ ] Add Slack notifications for failures
- [ ] Implement auto-pause on reply
- [ ] Add error recovery/retry logic

## Support

For issues or questions, check:
- Railway logs
- Supabase logs
- Smartlead dashboard
- This README

---

Built for OutboundHQ with ❤️
