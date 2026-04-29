-- ===========================================================
-- IVR overhaul (Batch 1): new welcome copy + restructured menus
-- ===========================================================
-- Pulls the menu structure in line with the 2026 spec:
--   1 = Company info (updated copy)
--   2 = Minute balance + packages submenu
--   3 = Account / save card submenu
--   4 = Tracking & orders submenu (NEW)
--   7 = Terms & security
--   9 = Yiddish admin office voicemail (moved from 4)
--   * = Replay menu
-- And updates the welcome copy for both new and returning callers.

-- Re-seed the editable prompt rows. We use UPSERT so admin edits to other
-- prompts are preserved; only the keys we touch are overwritten.

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('greeting_new',
   E'Welcome to Offline — your trusted partner for online help!\nWe handle everything online, so you don''t have to.\nNeed to shop online? Pay a bill? Update an account? Fill out a form? Reset a password? Check an order? We''ve got you covered!\nFrom Amazon to bills, banking to bookings, and so much more — if it''s online, we can do it for you, right over the phone.\nStay offline. We''ll handle the online.\nConnect now and let us make your life easier!',
   'First-time caller welcome (2026 spec).')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('greeting_returning',
   E'Welcome back to Offline, {full_name}!\nGreat to hear from you again — we''ll get you taken care of right away.',
   'Returning-caller greeting. {full_name} substituted.')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('main_menu',
   E'For a live agent, press 0.\nFor company information, press 1.\nFor minutes and packages, press 2.\nTo update your account info or save a card on file, press 3.\nFor tracking and recent orders, press 4.\nFor terms, conditions, and our security policy, press 7.\nTo leave a message for the Yiddish admin office, press 9.',
   'Main IVR menu options (2026 spec).')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('balance_menu',
   E'To hear your current minute balance, press 1.\nTo hear our price packages, press 2.\nTo buy a minutes package, press 3.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 2 (minutes & packages). Press 2 only LISTS prices; press 3 BUYS.')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('account_menu',
   E'To open an account or to update your information, press 1.\nTo securely save your credit card on file, press 2.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 3 (account). Option 1 routes to a rep with a note.')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

INSERT INTO ivr_prompts (key, text, description) VALUES
  ('tracking_menu',
   E'To hear tracking information of your recent order with our automatic system, press 1.\nTo hear your recent orders and forms, press 2.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 4 (tracking & orders).')
ON CONFLICT (key) DO UPDATE SET text = EXCLUDED.text, description = EXCLUDED.description, updated_at = now();

-- ============================================================
-- Admin toggle for the AI-intake question flow.
-- The IVR currently reads `Deno.env.get('AI_INTAKE_ENABLED')`.
-- We migrate to an `admin_settings` row so admins can toggle from the UI.
-- ============================================================
INSERT INTO admin_settings (key, value, description) VALUES
  ('ai_intake_enabled', to_jsonb(true), 'When true, callers who pick "live agent" first answer 1-2 AI intake questions before being queued. When false, callers go straight into the queue.')
ON CONFLICT (key) DO NOTHING;
