'use client';

import { useEffect, useState, use as usePromise } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/ui/page';
import { Loader2, User, ArrowLeft, AlertTriangle, Star } from 'lucide-react';

type Rep = {
  id: string;
  full_name: string;
  email: string | null;
  status: string;
  phone_extension: string | null;
};

type Call = {
  id: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  task_category_id: string | null;
  flag_status: string | null;
  customer_id: string | null;
};

type SkillRow = {
  task_category_id: string;
  call_count: number;
  avg_duration_seconds: number;
  resolution_rate: number | null;
  avg_rating: number | null;
  feedback_count: number;
};

type BehaviorFlag = {
  id: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  excerpt: string | null;
  reason: string | null;
  created_at: string;
  call_id: string;
};

type Feedback = {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  call_id: string | null;
};

type CategoryMap = Record<string, string>;

function fmtHMS(s: number | null): string {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const SEVERITY: Record<string, string> = {
  info: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/15 text-amber-600',
  critical: 'bg-rose-500/15 text-rose-600',
};

export default function RepDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [rep, setRep] = useState<Rep | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [flags, setFlags] = useState<BehaviorFlag[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [categories, setCategories] = useState<CategoryMap>({});
  const [shiftSummary, setShiftSummary] = useState({ active_seconds: 0, call_seconds: 0, sessions: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const [
        { data: r },
        { data: cats },
        { data: c },
        { data: s },
        { data: f },
        { data: fb },
        { data: sess },
      ] = await Promise.all([
        supabase.from('reps').select('id, full_name, email, status, phone_extension').eq('id', id).maybeSingle(),
        supabase.from('task_categories').select('id, name'),
        supabase.from('calls').select('id, started_at, ended_at, total_duration_seconds, task_category_id, flag_status, customer_id').eq('rep_id', id).order('started_at', { ascending: false }).limit(100),
        supabase.from('rep_skill_stats').select('*').eq('rep_id', id),
        supabase.from('call_behavior_flags').select('id, category, severity, excerpt, reason, created_at, call_id').eq('rep_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('customer_feedback').select('id, rating, comment, created_at, call_id').eq('rep_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('rep_sessions').select('total_active_seconds, total_call_seconds').eq('rep_id', id).not('ended_at', 'is', null),
      ]);
      setRep(r || null);
      setCategories(Object.fromEntries((cats || []).map((x) => [x.id, x.name])));
      setCalls(c || []);
      setSkills(s || []);
      setFlags(f || []);
      setFeedback(fb || []);
      const sumActive = (sess || []).reduce((t, x) => t + (x.total_active_seconds || 0), 0);
      const sumCalls = (sess || []).reduce((t, x) => t + (x.total_call_seconds || 0), 0);
      setShiftSummary({ active_seconds: sumActive, call_seconds: sumCalls, sessions: (sess || []).length });
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</div>;
  if (!rep) return <div className="py-12 text-center text-muted-foreground">Rep not found.</div>;

  const avgRating = feedback.length ? feedback.reduce((t, x) => t + x.rating, 0) / feedback.length : null;
  const criticalCount = flags.filter((f) => f.severity === 'critical').length;
  const flaggedCalls = calls.filter((c) => c.flag_status === 'flagged').length;

  return (
    <div className="space-y-6">
      <Link href="/admin/reps/board" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to rep board
      </Link>
      <PageHeader
        title={rep.full_name}
        description={`${rep.email || ''} ${rep.phone_extension ? `· ext ${rep.phone_extension}` : ''}`}
        icon={<User className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Lifetime calls" value={calls.length.toString()} />
        <Stat label="Active hours" value={(shiftSummary.active_seconds / 3600).toFixed(1)} />
        <Stat label="On-call hours" value={(shiftSummary.call_seconds / 3600).toFixed(1)} />
        <Stat label="Avg rating" value={avgRating ? `${avgRating.toFixed(2)} ★` : '—'} />
        <Stat label="Behavior flags" value={`${flags.length} (${criticalCount} crit)`} accent={criticalCount > 0 ? 'rose' : undefined} />
      </div>

      {criticalCount > 0 && (
        <div className="flex items-start gap-3 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
          <div>
            <div className="font-medium text-rose-600">Critical behavior flags detected</div>
            <div className="text-rose-700/80 dark:text-rose-300/80">{criticalCount} call(s) with critical AI moderation flags. Review below.</div>
          </div>
        </div>
      )}

      {/* Skill profile */}
      <section className="rounded-md border border-border bg-card">
        <header className="border-b border-border px-4 py-2 text-sm font-medium">Skill profile by category</header>
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium text-right">Calls</th>
              <th className="px-3 py-2 font-medium text-right">Avg duration</th>
              <th className="px-3 py-2 font-medium text-right">Resolution</th>
              <th className="px-3 py-2 font-medium text-right">Rating</th>
            </tr>
          </thead>
          <tbody>
            {skills.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">No skill data yet.</td></tr>
            ) : skills.map((s) => (
              <tr key={s.task_category_id} className="border-t border-border">
                <td className="px-3 py-2">{categories[s.task_category_id] || s.task_category_id}</td>
                <td className="px-3 py-2 text-right font-mono">{s.call_count}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(s.avg_duration_seconds)}</td>
                <td className="px-3 py-2 text-right font-mono">{s.resolution_rate != null ? `${(s.resolution_rate * 100).toFixed(0)}%` : '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{s.avg_rating != null ? `${Number(s.avg_rating).toFixed(2)} (${s.feedback_count})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Behavior flags */}
      {flags.length > 0 && (
        <section className="rounded-md border border-border bg-card">
          <header className="border-b border-border px-4 py-2 text-sm font-medium">AI behavior flags</header>
          <ul className="divide-y divide-border">
            {flags.map((f) => (
              <li key={f.id} className="px-4 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY[f.severity]}`}>{f.severity}</span>
                  <span className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 font-medium">{f.category.replace(/_/g, ' ')}</div>
                {f.reason && <div className="text-muted-foreground">{f.reason}</div>}
                {f.excerpt && <blockquote className="mt-1 border-l-2 border-border pl-2 italic text-muted-foreground">&quot;{f.excerpt}&quot;</blockquote>}
                <Link className="text-xs text-blue-600 hover:underline" href={`/admin/calls/${f.call_id}`}>Open call →</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Feedback */}
      {feedback.length > 0 && (
        <section className="rounded-md border border-border bg-card">
          <header className="border-b border-border px-4 py-2 text-sm font-medium">Customer feedback</header>
          <ul className="divide-y divide-border">
            {feedback.map((fb) => (
              <li key={fb.id} className="px-4 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-medium">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={`h-3.5 w-3.5 ${i < fb.rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`} />
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">{new Date(fb.created_at).toLocaleString()}</span>
                </div>
                {fb.comment && <p className="mt-1 text-muted-foreground">{fb.comment}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent calls */}
      <section className="rounded-md border border-border bg-card">
        <header className="border-b border-border px-4 py-2 text-sm font-medium">Recent calls (last 100)</header>
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium text-right">Duration</th>
              <th className="px-3 py-2 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No calls yet.</td></tr>}
            {calls.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link href={`/admin/calls/${c.id}`} className="hover:underline">
                    {new Date(c.started_at).toLocaleString()}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{c.task_category_id ? categories[c.task_category_id] : '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(c.total_duration_seconds)}</td>
                <td className="px-3 py-2">{c.flag_status === 'flagged' ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">flagged</span> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {flaggedCalls > 0 && (
          <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{flaggedCalls} of {calls.length} calls flagged</footer>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'rose' }) {
  return (
    <div className={`rounded-md border bg-card p-3 ${accent === 'rose' ? 'border-rose-500/30' : 'border-border'}`}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent === 'rose' ? 'text-rose-600' : ''}`}>{value}</div>
    </div>
  );
}
