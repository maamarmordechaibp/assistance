'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Save, MessageSquare, RefreshCw } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Prompt {
  key: string;
  text: string;
  description: string | null;
  updated_at: string;
}

export default function IvrEditorPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await edgeFn('ivr-prompts');
    if (res.ok) {
      const data = await res.json();
      const list = (data.prompts || []) as Prompt[];
      setPrompts(list);
      const d: Record<string, string> = {};
      for (const p of list) d[p.key] = p.text;
      setDrafts(d);
    } else {
      toast.error('Failed to load prompts');
    }
    setLoading(false);
  }

  async function save(p: Prompt) {
    setSaving(p.key);
    const res = await edgeFn('ivr-prompts', {
      method: 'PATCH',
      body: JSON.stringify({ key: p.key, text: drafts[p.key] ?? '' }),
    });
    if (res.ok) {
      toast.success(`Saved "${p.key}"`);
      const updated = await res.json();
      setPrompts((prev) => prev.map((x) => (x.key === p.key ? { ...x, text: updated.text, updated_at: updated.updated_at } : x)));
    } else {
      toast.error('Save failed');
    }
    setSaving(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageSquare className="w-5 h-5" /> IVR Editor
        </h1>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <p className="text-sm text-gray-600">
        Edit the wording and button order callers hear. Use one line per
        sentence/option — newlines are spoken as natural pauses. Variables
        like <code className="bg-gray-100 px-1 rounded">{'{full_name}'}</code> are
        substituted at call time. Changes propagate within ~1 minute.
      </p>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : prompts.length === 0 ? (
        <div className="bg-white rounded border p-10 text-center text-gray-500">
          No prompts in the database yet. Run the <code>20260426_ivr_prompts.sql</code> migration to seed defaults.
        </div>
      ) : (
        <div className="space-y-4">
          {prompts.map((p) => (
            <div key={p.key} className="bg-white rounded border p-4">
              <div className="flex items-baseline justify-between mb-2">
                <div>
                  <code className="font-semibold text-blue-700">{p.key}</code>
                  {p.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{p.description}</div>
                  )}
                </div>
                <div className="text-xs text-gray-400">
                  Updated {new Date(p.updated_at).toLocaleString()}
                </div>
              </div>
              <textarea
                rows={Math.max(3, (drafts[p.key] || '').split('\n').length + 1)}
                value={drafts[p.key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: e.target.value }))}
                className="w-full font-mono text-sm border rounded p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex justify-end mt-2">
                <button
                  onClick={() => save(p)}
                  disabled={saving === p.key || (drafts[p.key] ?? '') === p.text}
                  className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
                >
                  {saving === p.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
