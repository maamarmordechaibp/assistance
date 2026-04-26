-- Editable IVR prompts. Lets the admin tweak menu wording, slogan,
-- disclosures, etc. without redeploying the edge function.
-- Each row is one logical prompt. Multi-line prompts are stored as one
-- string with newlines; the runtime joins/splits as needed.

CREATE TABLE IF NOT EXISTS ivr_prompts (
  key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

ALTER TABLE ivr_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ivr_prompts_admin_all" ON ivr_prompts;
CREATE POLICY "ivr_prompts_admin_all" ON ivr_prompts FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

DROP POLICY IF EXISTS "ivr_prompts_service_role" ON ivr_prompts;
CREATE POLICY "ivr_prompts_service_role" ON ivr_prompts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Allow authenticated reps to read prompts (read-only) so the rep dashboard
-- can preview them. Adjust if not desired.
DROP POLICY IF EXISTS "ivr_prompts_authed_read" ON ivr_prompts;
CREATE POLICY "ivr_prompts_authed_read" ON ivr_prompts FOR SELECT
  TO authenticated USING (true);

-- Seed defaults. Use ON CONFLICT DO NOTHING so re-running is safe and we
-- never overwrite admin edits.
INSERT INTO ivr_prompts (key, text, description) VALUES
  ('greeting_new',
   E'Hi there, and thanks for calling Offline!\nWe''re your real human team for everything online — shopping, bills, forms, accounts, you name it.\nStay offline, and we''ll handle the online for you.\nBy continuing this call, you agree to our terms and conditions.',
   'First-time caller greeting (split lines with newlines).'),
  ('greeting_returning',
   E'Hey {full_name}, welcome back to Offline!\nGreat to hear from you again — let''s get you taken care of.',
   'Returning-caller greeting. {full_name} substituted.'),
  ('main_menu',
   E'For a live agent, press 0.\nFor company information, press 1.\nFor minutes and packages, press 2.\nTo update your account info or save a card on file, press 3.\nTo leave a message for the Yiddish admin office, press 4.\nFor terms, conditions, and our security policy, press 7.',
   'Main IVR menu options.'),
  ('agent_menu',
   E'To speak with the next available agent, press 1.\nTo buy more minutes, press star then 2.\nTo connect with a specific extension, press 2.\nTo reconnect with the agent from your most recent call, press 3.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 0 (live agent).'),
  ('balance_menu',
   E'To hear your current minute balance, press 1.\nTo hear our minute packages, press 2.\nTo refill using the last package you bought, press 3.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 2 (minutes & packages).'),
  ('account_menu',
   E'To update your name, phone, email, and mailing address with our automated system, press 1.\nTo securely save your credit card on file, press 2.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 3 (update account).'),
  ('terms_menu',
   E'To hear our terms and conditions, press 1.\nTo hear our security measures, press 2.\nTo return to the main menu, press star.',
   'Submenu after the caller presses 7 (terms & security).'),
  ('voicemail_yiddish_intro',
   E'Please leave your message for the Yiddish admin office after the tone.\nBe sure to include your name, phone number, and the reason for your call.',
   'Played before the voicemail beep.'),
  ('voicemail_complete',
   E'Your message has been received.\nThank you for calling Offline. Goodbye.',
   'Played after a voicemail finishes recording.')
ON CONFLICT (key) DO NOTHING;
