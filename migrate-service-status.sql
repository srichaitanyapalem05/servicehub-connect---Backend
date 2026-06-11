-- Add service_status enum and status column to services table
DO $$ BEGIN
  CREATE TYPE service_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE services ADD COLUMN IF NOT EXISTS status service_status NOT NULL DEFAULT 'pending';

-- Approve all existing services so they remain visible
UPDATE services SET status = 'approved' WHERE status = 'pending';
