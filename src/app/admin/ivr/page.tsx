'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Save, MessageSquare, RefreshCw } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { PageHeader, EmptyState } from '@/components/ui/page';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';

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
      <PageHeader
        icon={<MessageSquare />}
        title="IVR Editor"
        description="Edit the wording and button order callers hear. Newlines render as natural pauses. Variables like {full_name} are substituted at call time. Changes propagate within ~1 minute."
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw /> Refresh
          </Button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : prompts.length === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No prompts yet"
          description={<span>Run the <code>20260426_ivr_prompts.sql</code> migration to seed defaults.</span>}
        />
      ) : (
        <div className="space-y-3">
          {prompts.map((p) => (
            <Card key={p.key} className="p-4">
              <div className="flex items-baseline justify-between mb-2 gap-2">
                <div className="min-w-0">
                  <code className="font-semibold text-accent">{p.key}</code>
                  {p.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">{p.description}</div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground/80 shrink-0">
                  Updated {new Date(p.updated_at).toLocaleString()}
                </div>
              </div>
              <Textarea
                rows={Math.max(3, (drafts[p.key] || '').split('\n').length + 1)}
                value={drafts[p.key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: e.target.value }))}
                className="font-mono"
              />
              <div className="flex justify-end mt-2">
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => save(p)}
                  disabled={saving === p.key || (drafts[p.key] ?? '') === p.text}
                  loading={saving === p.key}
                >
                  {saving !== p.key && <Save />}
                  Save
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
