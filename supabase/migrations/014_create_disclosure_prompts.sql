-- ============================================
-- 014: Disclosure prompts
-- ============================================

CREATE TABLE disclosure_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  plays_before_routing BOOLEAN NOT NULL DEFAULT true,
  requires_acknowledgment BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_disclosure_prompts_updated_at
  BEFORE UPDATE ON disclosure_prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
