-- Question analytics metadata reliability migration
-- Run once in Supabase SQL editor (idempotent).

ALTER TABLE public.question_analytics
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_question_analytics_outcome_expr
ON public.question_analytics ((metadata->>'outcome'));

CREATE INDEX IF NOT EXISTS idx_question_analytics_timestamp
ON public.question_analytics (timestamp DESC);
