-- Add Smartlead credentials columns to profiles table
-- Run this in your Supabase SQL editor

ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS smartlead_api_key TEXT,
ADD COLUMN IF NOT EXISTS smartlead_email_account_id TEXT;

-- Add helpful comment
COMMENT ON COLUMN profiles.smartlead_api_key IS 'User Smartlead API key for sending sequences';
COMMENT ON COLUMN profiles.smartlead_email_account_id IS 'User selected Smartlead email account ID for sending';
