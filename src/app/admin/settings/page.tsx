'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Settings, Save, Loader2, Upload, Trash2, Play } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { createClient } from '@/lib/supabase/client';

interface Setting {
  id: string;
  key: string;
  value: unknown;
  description: string | null;
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSettings() {
      const res = await edgeFn('settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings || []);
        const vals: Record<string, string> = {};
        data.settings?.forEach((s: Setting) => {
          vals[s.key] = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
        });
        setEditValues(vals);
      }
      setLoading(false);
    }
    fetchSettings();
  }, []);

  const handleSave = async (key: string) => {
    setSaving(key);
    let value: unknown = editValues[key];
    // Try parsing as JSON
    try {
      value = JSON.parse(editValues[key]);
    } catch {
      // Keep as string
    }

    const res = await edgeFn('settings', {
      method: 'PATCH',
      body: JSON.stringify({ key, value }),
    });

    if (res.ok) {
      const updated = await res.json();
      setSettings(settings.map(s => s.key === key ? { ...s, value: updated.value } : s));
      toast.success('Setting saved');
    } else {
      toast.error('Failed to save setting');
    }
    setSaving(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Group settings
  const groups: Record<string, Setting[]> = {
    'Balance & Billing': settings.filter(s =>
      ['negative_balance_enabled', 'max_negative_balance', 'first_time_zero_balance', 'rep_continue_after_zero'].includes(s.key)
    ),
    'Call Duration': settings.filter(s =>
      ['max_call_duration_minutes', 'extension_minutes', 'max_extensions_per_call'].includes(s.key)
    ),
    'Queue': settings.filter(s =>
      ['queue_max_wait_minutes', 'queue_callback_threshold', 'hold_music_url', 'queue_position_announcement'].includes(s.key)
    ),
    'Announcements': settings.filter(s =>
      ['minute_announcement_enabled', 'minute_announcement_text'].includes(s.key)
    ),
    'AI': settings.filter(s =>
      ['ai_analysis_enabled'].includes(s.key)
    ),
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <Settings className="w-5 h-5" />
        Settings
      </h2>

      <HoldMusicUploader
        currentUrl={typeof settings.find(s => s.key === 'hold_music_url')?.value === 'string' ? settings.find(s => s.key === 'hold_music_url')!.value as string : ''}
        onSaved={(url) => {
          setSettings(prev => prev.map(s => s.key === 'hold_music_url' ? { ...s, value: url } : s));
          setEditValues(prev => ({ ...prev, hold_music_url: url }));
        }}
      />

      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="bg-white rounded-xl shadow-sm border">
          <div className="px-6 py-4 border-b">
            <h3 className="font-semibold">{group}</h3>
          </div>
          <div className="divide-y">
            {items.map((setting) => (
              <div key={setting.key} className="px-6 py-4 flex items-center gap-4">
                <div className="flex-1">
                  <div className="text-sm font-medium">{setting.key}</div>
                  {setting.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{setting.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editValues[setting.key] || ''}
                    onChange={(e) =>
                      setEditValues({ ...editValues, [setting.key]: e.target.value })
                    }
                    className="w-48 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={() => handleSave(setting.key)}
                    disabled={saving === setting.key}
                    className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving === setting.key ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function HoldMusicUploader({ currentUrl, onSaved }: { currentUrl: string; onSaved: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  async function handleUpload() {
    if (!pendingFile) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = pendingFile.name.split('.').pop()?.toLowerCase() || 'mp3';
      const path = `custom-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('hold-music')
        .upload(path, pendingFile, { upsert: true, contentType: pendingFile.type || 'audio/mpeg' });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('hold-music').getPublicUrl(path);
      const url = pub.publicUrl;
      const res = await edgeFn('settings', {
        method: 'PATCH',
        body: JSON.stringify({ key: 'hold_music_url', value: url }),
      });
      if (!res.ok) throw new Error('Save failed');
      onSaved(url);
      setPendingFile(null);
      toast.success('Hold music updated. Callers will hear it on the next call.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function clearMusic() {
    if (!confirm('Reset hold music to the SignalWire default?')) return;
    const res = await edgeFn('settings', {
      method: 'PATCH',
      body: JSON.stringify({ key: 'hold_music_url', value: '' }),
    });
    if (res.ok) {
      onSaved('');
      toast.success('Reset to default music');
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border">
      <div className="px-6 py-4 border-b">
        <h3 className="font-semibold flex items-center gap-2">
          <Play className="w-4 h-4" /> Hold music
        </h3>
        <p className="text-xs text-gray-500 mt-1">Upload an MP3/WAV that callers hear while waiting in queue.</p>
      </div>
      <div className="px-6 py-4 space-y-3">
        {currentUrl ? (
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded">
            <audio controls src={currentUrl} className="flex-1 max-w-md" />
            <button
              onClick={clearMusic}
              className="p-2 rounded hover:bg-red-50 text-red-600"
              title="Reset to default"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic">Using SignalWire default hold music.</div>
        )}
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => setPendingFile(e.target.files?.[0] || null)}
            className="text-sm"
          />
          <button
            onClick={handleUpload}
            disabled={!pendingFile || uploading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}
