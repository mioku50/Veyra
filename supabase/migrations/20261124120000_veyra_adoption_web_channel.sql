-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Separate web UI free verdicts from direct REST and MCP calls.
ALTER TABLE public.veyra_adoption_callers
  ADD COLUMN IF NOT EXISTS first_web_verdict_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.record_veyra_adoption_event(
  p_event TEXT,
  p_week DATE,
  p_caller TEXT,
  p_occurred_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('rest_verdict', 'mcp_verdict', 'web_verdict', 'paid_history')
    OR p_occurred_at IS NULL
    OR p_week IS DISTINCT FROM date_trunc('week', p_occurred_at AT TIME ZONE 'UTC')::DATE
  THEN
    RAISE EXCEPTION 'Invalid adoption metric event or UTC week' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.veyra_adoption_callers AS callers (
    week, caller, first_rest_verdict_at, first_mcp_verdict_at, first_web_verdict_at, last_paid_history_at
  ) VALUES (
    p_week,
    p_caller,
    CASE WHEN p_event = 'rest_verdict' THEN p_occurred_at END,
    CASE WHEN p_event = 'mcp_verdict' THEN p_occurred_at END,
    CASE WHEN p_event = 'web_verdict' THEN p_occurred_at END,
    CASE WHEN p_event = 'paid_history' THEN p_occurred_at END
  )
  ON CONFLICT (week, caller) DO UPDATE SET
    first_rest_verdict_at = LEAST(callers.first_rest_verdict_at, EXCLUDED.first_rest_verdict_at),
    first_mcp_verdict_at = LEAST(callers.first_mcp_verdict_at, EXCLUDED.first_mcp_verdict_at),
    first_web_verdict_at = LEAST(callers.first_web_verdict_at, EXCLUDED.first_web_verdict_at),
    last_paid_history_at = GREATEST(callers.last_paid_history_at, EXCLUDED.last_paid_history_at);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_veyra_adoption_event(TEXT, DATE, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_veyra_adoption_event(TEXT, DATE, TEXT, TIMESTAMPTZ)
  TO service_role;

CREATE OR REPLACE VIEW public.veyra_adoption_weekly WITH (security_invoker = true) AS
SELECT
  week,
  COUNT(first_rest_verdict_at) AS rest_verdict_callers,
  COUNT(first_mcp_verdict_at) AS mcp_verdict_callers,
  COUNT(*) FILTER (
    WHERE first_rest_verdict_at IS NOT NULL
      OR first_mcp_verdict_at IS NOT NULL
      OR first_web_verdict_at IS NOT NULL
  ) AS verdict_callers,
  COUNT(last_paid_history_at) AS paid_history_callers,
  COUNT(*) FILTER (
    WHERE last_paid_history_at > LEAST(first_rest_verdict_at, first_mcp_verdict_at, first_web_verdict_at)
  ) AS verdict_to_paid_history_callers,
  COUNT(first_web_verdict_at) AS web_verdict_callers
FROM public.veyra_adoption_callers
GROUP BY week;

REVOKE ALL ON TABLE public.veyra_adoption_weekly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.veyra_adoption_weekly TO service_role;
