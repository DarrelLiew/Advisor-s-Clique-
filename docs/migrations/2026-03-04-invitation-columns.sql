-- Add invitation tracking columns to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS invitation_status TEXT DEFAULT 'pending' CHECK (invitation_status IN ('pending', 'accepted'));

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS invitation_sent_at TIMESTAMPTZ;

-- Mark existing users as accepted (they already have access)
UPDATE public.profiles SET invitation_status = 'accepted' WHERE invitation_status IS NULL OR invitation_status = 'pending';
