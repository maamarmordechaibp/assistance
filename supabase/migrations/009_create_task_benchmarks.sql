-- ============================================
-- 009: Task benchmarks
-- ============================================

CREATE TABLE task_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_category_id UUID NOT NULL UNIQUE REFERENCES task_categories(id) ON DELETE CASCADE,
  expected_min_minutes INT NOT NULL,
  expected_max_minutes INT NOT NULL,
  flag_threshold_minutes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_task_benchmarks_updated_at
  BEFORE UPDATE ON task_benchmarks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
