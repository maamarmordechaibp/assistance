"use client";
import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const supabase = createClient();
const BUCKET = 'sms-media';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

interface Props {
  value: string;
  onChange: (url: string) => void;
}

export default function SmsMediaPicker({ value, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFile(file: File) {
    setError(null);
    if (!ALLOWED.includes(file.type)) {
      setError(`Unsupported file type: ${file.type || 'unknown'}`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File too large (max 5MB).');
      return;
    }
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const uid = user?.id ?? 'anon';
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      onChange(pub.publicUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          uploadFile(f);
          return;
        }
      }
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadFile(f);
  }

  return (
    <div
      className="space-y-2"
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-1.5 rounded-lg border bg-background text-xs hover:bg-accent/10 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : value ? 'Replace image' : '📎 Attach image'}
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="px-3 py-1.5 rounded-lg border bg-background text-xs hover:bg-destructive/10"
          >
            Remove
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowUrl(v => !v)}
          className="text-xs text-accent underline"
        >
          {showUrl ? 'Hide URL field' : 'Or paste URL'}
        </button>
        <span className="text-xs text-muted-foreground">(or paste/drop image here)</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadFile(f);
          e.target.value = '';
        }}
      />
      {showUrl && (
        <input
          type="url"
          placeholder="https://… (publicly accessible image URL)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      )}
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={value}
          alt="MMS attachment preview"
          className="max-h-40 rounded-lg border object-contain bg-muted"
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
