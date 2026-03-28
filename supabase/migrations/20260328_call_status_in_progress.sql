-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add `in_progress` to call_status enum
-- Twilio fires a status webhook with "in-progress" which maps to in_progress.
-- Without this value the voice webhook DB update fails and twilio_call_sid
-- is never stored, breaking call recording lookup.
-- Run in Supabase SQL editor or via supabase db push.
-- ─────────────────────────────────────────────────────────────────────────────

-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction block.
-- Supabase SQL editor runs each statement independently so this is safe.
ALTER TYPE call_status ADD VALUE IF NOT EXISTS 'in_progress';
