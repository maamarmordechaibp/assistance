-- Private bucket for call audio recordings.
-- Service role (edge functions) writes; admins read via signed URLs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  false,
  524288000, -- 500 MB
  ARRAY['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/webm', 'audio/ogg']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Admins can read recordings (used to issue signed URLs from the client).
DROP POLICY IF EXISTS "call_recordings_admin_read" ON storage.objects;
CREATE POLICY "call_recordings_admin_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'call-recordings'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- No public/anon access. Edge functions use the service role key, which
-- bypasses RLS, so they can write/read regardless of these policies.
