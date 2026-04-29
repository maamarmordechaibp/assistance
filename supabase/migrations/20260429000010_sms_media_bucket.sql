-- SMS media bucket: stores images that reps/admins attach to outbound MMS.
-- Public read so SignalWire can fetch the media URL; authenticated write only.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sms-media', 'sms-media', true, 5242880,
        ARRAY['image/png','image/jpeg','image/gif','image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "sms_media_public_read"  ON storage.objects;
CREATE POLICY "sms_media_public_read" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'sms-media');

DROP POLICY IF EXISTS "sms_media_auth_insert"  ON storage.objects;
CREATE POLICY "sms_media_auth_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'sms-media'
    AND (
      public.user_role() = 'admin'
      OR EXISTS (SELECT 1 FROM reps r WHERE r.id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "sms_media_auth_update"  ON storage.objects;
CREATE POLICY "sms_media_auth_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'sms-media'
    AND (
      public.user_role() = 'admin'
      OR EXISTS (SELECT 1 FROM reps r WHERE r.id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "sms_media_auth_delete"  ON storage.objects;
CREATE POLICY "sms_media_auth_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'sms-media'
    AND (
      public.user_role() = 'admin'
      OR EXISTS (SELECT 1 FROM reps r WHERE r.id = auth.uid())
    )
  );
