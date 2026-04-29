'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Settings, Save, Loader2, Upload, Trash2, Play } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { PageHeader } from '@/components/ui/page';
import { createClient } from '@/lib/supabase/client';
import AdminPhoneNumbers from '@/components/admin/AdminPhoneNumbers';

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

  // A setting is a boolean if its current persisted value is a JS boolean,
  // or if its raw text representation is exactly "true" / "false".
  const isBooleanSetting = (s: Setting) => {
    if (typeof s.value === 'boolean') return true;
    const raw = (editValues[s.key] ?? '').trim().toLowerCase();
    return raw === 'true' || raw === 'false';
  };

  const getBoolValue = (key: string): boolean => {
    const raw = (editValues[key] ?? '').trim().toLowerCase();
    return raw === 'true';
  };

  const handleSave = async (key: string, overrideValue?: unknown) => {
    setSaving(key);
    let value: unknown;
    if (overrideValue !== undefined) {
      value = overrideValue;
    } else {
      value = editValues[key];
      try {
        value = JSON.parse(editValues[key]);
      } catch {
        // keep as string
      }
    }

    const res = await edgeFn('settings', {
      method: 'PATCH',
      body: JSON.stringify({ key, value }),
    });

    if (res.ok) {
      const updated = await res.json();
      setSettings(prev => prev.map(s => s.key === key ? { ...s, value: updated.value } : s));
      setEditValues(prev => ({
        ...prev,
        [key]: typeof updated.value === 'string' ? updated.value : JSON.stringify(updated.value),
      }));
      toast.success('Setting saved');
    } else {
      toast.error('Failed to save setting');
    }
    setSaving(null);
  };

  const toggleBoolean = async (key: string) => {
    const next = !getBoolValue(key);
    setEditValues(prev => ({ ...prev, [key]: String(next) }));
    await handleSave(key, next);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
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
      ['ai_analysis_enabled', 'behavior_moderation_enabled', 'smart_routing_enabled'].includes(s.key)
    ),
    'Critical Alerts': settings.filter(s =>
      ['admin_phone_alert_throttle_seconds'].includes(s.key)
    ),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Settings />}
        title="Settings"
        description="System configuration and integration credentials."
      />

      <HoldMusicUploader
        currentUrl={typeof settings.find(s => s.key === 'hold_music_url')?.value === 'string' ? settings.find(s => s.key === 'hold_music_url')!.value as string : ''}
        onSaved={(url) => {
          setSettings(prev => prev.map(s => s.key === 'hold_music_url' ? { ...s, value: url } : s));
          setEditValues(prev => ({ ...prev, hold_music_url: url }));
        }}
      />

      <AdminPhoneNumbers />

      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="bg-card rounded-xl shadow-sm border">
          <div className="px-6 py-4 border-b">
            <h3 className="font-semibold">{group}</h3>
          </div>
          <div className="divide-y">
            {items.map((setting) => {
              const isBool = isBooleanSetting(setting);
              return (
                <div key={setting.key} className="px-6 py-4 flex items-center gap-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{setting.key}</div>
                    {setting.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">{setting.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isBool ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={getBoolValue(setting.key)}
                        disabled={saving === setting.key}
                        onClick={() => toggleBoolean(setting.key)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                          getBoolValue(setting.key) ? 'bg-accent' : 'bg-muted-foreground/30'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                            getBoolValue(setting.key) ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                        {saving === setting.key && (
                          <Loader2 className="absolute -right-6 w-4 h-4 animate-spin text-muted-foreground" />
                        )}
                      </button>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={editValues[setting.key] || ''}
                          onChange={(e) =>
                            setEditValues({ ...editValues, [setting.key]: e.target.value })
                          }
                          className="w-48 rounded-lg border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                          onClick={() => handleSave(setting.key)}
                          disabled={saving === setting.key}
                          className="p-2 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                        >
                          {saving === setting.key ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4" />
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
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
    <div className="bg-card rounded-xl shadow-sm border">
      <div className="px-6 py-4 border-b">
        <h3 className="font-semibold flex items-center gap-2">
          <Play className="w-4 h-4" /> Hold music
        </h3>
        <p className="text-xs text-muted-foreground mt-1">Upload an MP3/WAV that callers hear while waiting in queue.</p>
      </div>
      <div className="px-6 py-4 space-y-3">
        {currentUrl ? (
          <div className="flex items-center gap-3 p-3 bg-muted/40 rounded">
            <audio controls src={currentUrl} className="flex-1 max-w-md" />
            <button
              onClick={clearMusic}
              className="p-2 rounded hover:bg-destructive/10 text-destructive"
              title="Reset to default"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic">Using SignalWire default hold music.</div>
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
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 text-sm"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}
