'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Settings, Save, Loader2 } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

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
