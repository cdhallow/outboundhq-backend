# OutboundHQ Backend v2 - Per-User Smartlead Support

Backend service with per-user Smartlead account support. Each SDR connects their own Smartlead account and sends from their own email.

## What's New in v2

✅ **Per-User Smartlead Accounts** - Each user connects their own Smartlead API key  
✅ **User-Specific Email Accounts** - Sequences send from the SDR's configured email  
✅ **No Global API Keys** - Backend pulls credentials from user profiles  

---

## Setup Instructions

### 1. Database Migration

**Run this SQL in your Supabase SQL Editor:**

```sql
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS smartlead_api_key TEXT,
ADD COLUMN IF NOT EXISTS smartlead_email_account_id TEXT;
```

This adds columns to store each user's Smartlead credentials.

---

### 2. Deploy to Railway

**Environment Variables Needed:**
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (NOT anon key)
- `NODE_ENV` - Set to `production`

**NO Smartlead keys needed!** Those are now stored per-user in the database.

---

### 3. Frontend Changes Needed

You'll need to build a "Connect Smartlead" feature in Lovable where users:

1. Enter their Smartlead API key
2. System fetches their available email accounts
3. User selects which email to use for sending
4. Credentials saved to their `profiles` row

---

## How It Works

### Sequence Creation Flow:

1. **User creates sequence** in Lovable
2. Sequence record includes `created_by` (user ID)
3. When sequence is activated, backend uses that user's Smartlead credentials

### Sequence Execution Flow:

1. **Cron job runs every 15 min**
2. For each enrollment ready to send:
   - Get the sequence's `created_by` user
   - Fetch that user's `smartlead_api_key` and `smartlead_email_account_id` from profiles
   - Use those credentials to add lead to campaign
3. Email sends from the SDR's email account

---

## API Endpoints

### Health Check
```
GET /health
```

### Smartlead Webhook
```
POST /webhooks/smartlead
```

### Manual Sequence Execution (Testing)
```
POST /cron/execute-sequences
```

---

## Testing

**Before sequences will work, users MUST:**
1. Connect their Smartlead account in the frontend
2. Have `smartlead_api_key` and `smartlead_email_account_id` set in their profile

**If missing:**
- Backend will log: "User X has not connected their Smartlead account"
- Sequence will be skipped

---

## Next Steps

1. ✅ Run database migration (add columns to profiles)
2. ✅ Deploy updated backend to Railway
3. ⏳ Build "Connect Smartlead" UI in Lovable
4. ⏳ Test with real Smartlead accounts

---

## Files Changed from v1

**Modified:**
- `src/services/smartlead.ts` - Now accepts API key as parameter
- `src/services/supabase.ts` - Added `getUserSmartleadCredentials()` function
- `src/cron/sequence-executor.ts` - Fetches per-user credentials before sending

**Added:**
- `DATABASE_MIGRATION.sql` - SQL to add new columns

---

Built for OutboundHQ with ❤️
