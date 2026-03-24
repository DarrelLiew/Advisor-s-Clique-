-- Migration: Add 'agent' mode to chat_sessions
-- Run this in Supabase SQL Editor before using Agent mode

-- 1. Widen the mode CHECK constraint to allow 'agent'
ALTER TABLE public.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_mode_check;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_mode_check CHECK (mode IN ('client', 'learner', 'agent'));

-- 2. Update the schema.sql reference (informational only — update schema.sql manually)
-- The chat_sessions.mode column now accepts: 'client', 'learner', 'agent'
