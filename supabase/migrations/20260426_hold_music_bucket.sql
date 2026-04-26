-- Public bucket for IVR hold music. Anyone can read (it's served to
-- SignalWire's <Play>), only admins can upload/delete.

INSERT INTO storage.buckets (id, name, public)
VALUES ('hold-music', 'hold-music', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "hold_music_public_read" ON storage.objects;
CREATE POLICY "hold_music_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'hold-music');

DROP POLICY IF EXISTS "hold_music_admin_write" ON storage.objects;
CREATE POLICY "hold_music_admin_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'hold-music'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "hold_music_admin_update" ON storage.objects;
CREATE POLICY "hold_music_admin_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'hold-music'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "hold_music_admin_delete" ON storage.objects;
CREATE POLICY "hold_music_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'hold-music'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
