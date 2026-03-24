-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Instantly integration
-- Run this in Supabase SQL editor or via supabase db push
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add instantly_campaign_id to sequences
--    Keep smartlead_campaign_id nullable for backwards compatibility during cutover
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT;

-- 2. email_messages table — stores full email bodies for conversation threading
CREATE TABLE IF NOT EXISTS email_messages (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            UUID        REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id         UUID        REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  sequence_id           UUID        REFERENCES sequences(id) ON DELETE SET NULL,
  assigned_sdr_id       UUID        REFERENCES profiles(id) ON DELETE SET NULL,

  direction             TEXT        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  subject               TEXT,
  body_text             TEXT,
  body_html             TEXT,
  from_address          TEXT,
  to_address            TEXT,

  instantly_message_id  TEXT        UNIQUE,
  instantly_campaign_id TEXT,
  thread_id             TEXT,

  ai_classification     TEXT        CHECK (ai_classification IN (
                                      'interested', 'not_interested', 'question', 'objection',
                                      'out_of_office', 'unsubscribe', 'other'
                                    )),
  ai_suggested_reply    TEXT,

  status                TEXT        DEFAULT 'delivered' CHECK (status IN (
                                      'delivered', 'pending_review', 'replied', 'dismissed'
                                    )),

  sent_at               TIMESTAMPTZ,
  received_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_messages_contact_id
  ON email_messages(contact_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_enrollment_id
  ON email_messages(enrollment_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_assigned_sdr_id
  ON email_messages(assigned_sdr_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_id
  ON email_messages(thread_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_status
  ON email_messages(status);

CREATE INDEX IF NOT EXISTS idx_email_messages_instantly_campaign_id
  ON email_messages(instantly_campaign_id);

-- 3. contacts: add unsubscribed_at if not present
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;
