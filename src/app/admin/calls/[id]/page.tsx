'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { formatDuration, formatDateTime, formatPhone } from '@/lib/utils';
import { ArrowLeft, Clock, User, Phone, FileText, Brain, AlertTriangle, Loader2, RefreshCw, Mic } from 'lucide-react';
import Link from 'next/link';

interface CallDetail {
  id: string;
  customer_id: string | null;
  rep_id: string | null;
  inbound_phone: string;
  call_sid: string;
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  total_duration_seconds: number | null;
  billable_duration_seconds: number | null;
  minutes_deducted: number;
  recording_url: string | null;
  recording_storage_path: string | null;
  transcript_text: string | null;
  rep_notes: string | null;
  outcome_status: string | null;
  followup_needed: boolean;
  flag_status: string;
  flag_reason: string | null;
  extensions_used: number;
  customer?: { full_name: string; primary_phone: string } | null;
  rep?: { full_name: string; email: string } | null;
  task_category?: { name: string } | null;
}

interface Analysis {
  ai_summary: string;
  ai_category: string;
  ai_success_status: string;
  ai_sentiment: string;
  ai_followup_needed: boolean;
  ai_wasted_time_flag: boolean;
  ai_flag_reason: string | null;
  ai_confidence_score: number;
}

export default function AdminCallDetail() {
  const { id } = useParams();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [recordingSignedUrl, setRecordingSignedUrl] = useState<string | null>(null);
  const supabase = createClient();

  async function runAnalysis() {
    if (!id) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await edgeFn('ai-analyze', {
        method: 'POST',
        body: JSON.stringify({ callId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAnalyzeError(data?.error || `Analysis failed (${res.status})`);
      } else {
        setAnalysis(data as Analysis);
      }
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }

  async function runTranscribe() {
    if (!id || !call?.recording_storage_path) return;
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const res = await edgeFn('sw-transcription', {
        method: 'POST',
        body: JSON.stringify({ callId: id, storagePath: call.recording_storage_path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTranscribeError(data?.error || `Transcription failed (${res.status})`);
      } else {
        // Refresh call so transcript_text shows up; ai-analyze is auto-triggered server-side.
        const { data: refreshed } = await supabase
          .from('calls')
          .select(`*, customer:customers(full_name, primary_phone), rep:reps(full_name, email), task_category:task_categories(name)`) 
          .eq('id', id)
          .single();
        if (refreshed) setCall(refreshed as unknown as CallDetail);
        // Poll once for analysis a few seconds later.
        setTimeout(async () => {
          const { data: a } = await supabase.from('call_analyses').select('*').eq('call_id', id).maybeSingle();
          if (a) setAnalysis(a as Analysis);
        }, 4000);
      }
    } catch (e) {
      setTranscribeError(e instanceof Error ? e.message : 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  }

  useEffect(() => {
    async function load() {
      const { data: callData } = await supabase
        .from('calls')
        .select(`
          *,
          customer:customers(full_name, primary_phone),
          rep:reps(full_name, email),
          task_category:task_categories(name)
        `)
        .eq('id', id)
        .single();

      if (callData) setCall(callData as unknown as CallDetail);

      const { data: analysisData } = await supabase
        .from('call_analyses')
        .select('*')
        .eq('call_id', id)
        .maybeSingle();

      if (analysisData) setAnalysis(analysisData as Analysis);

      // Generate a short-lived signed URL for the stored recording so the
      // admin can play it back without exposing the bucket publicly.
      const storagePath = (callData as { recording_storage_path?: string } | null)?.recording_storage_path;
      if (storagePath) {
        const { data: signed } = await supabase
          .storage
          .from('call-recordings')
          .createSignedUrl(storagePath, 60 * 30);
        if (signed?.signedUrl) setRecordingSignedUrl(signed.signedUrl);
      }
      setLoading(false);
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!call) {
    return <div className="text-center py-12 text-muted-foreground">Call not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/calls" className="p-2 rounded-lg hover:bg-muted">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h2 className="text-xl font-semibold">Call Detail</h2>
        {call.flag_status === 'flagged' && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-destructive/15 text-destructive">
            <AlertTriangle className="w-3 h-3" />
            Flagged
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Call Info */}
        <div className="bg-card rounded-xl shadow-sm border p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Phone className="w-4 h-4" /> Call Information
          </h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-muted-foreground">Customer:</span> {call.customer?.full_name || 'Unknown'}</div>
            <div><span className="text-muted-foreground">Phone:</span> {formatPhone(call.inbound_phone)}</div>
            <div><span className="text-muted-foreground">Rep:</span> {call.rep?.full_name || 'N/A'}</div>
            <div><span className="text-muted-foreground">Category:</span> {call.task_category?.name || 'N/A'}</div>
            <div><span className="text-muted-foreground">Started:</span> {formatDateTime(call.started_at)}</div>
            <div><span className="text-muted-foreground">Ended:</span> {call.ended_at ? formatDateTime(call.ended_at) : 'Ongoing'}</div>
            <div>
              <span className="text-muted-foreground">Duration:</span>{' '}
              {call.total_duration_seconds ? formatDuration(call.total_duration_seconds) : '—'}
            </div>
            <div><span className="text-muted-foreground">Minutes Billed:</span> {call.minutes_deducted}</div>
            <div><span className="text-muted-foreground">Extensions:</span> {call.extensions_used}</div>
            <div>
              <span className="text-muted-foreground">Outcome:</span>{' '}
              {call.outcome_status ? (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  call.outcome_status === 'resolved' ? 'bg-success/15 text-success' :
                  call.outcome_status === 'partial' ? 'bg-warning/15 text-warning' :
                  'bg-destructive/15 text-destructive'
                }`}>{call.outcome_status}</span>
              ) : '—'}
            </div>
          </div>
          {call.flag_reason && (
            <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/30 text-sm">
              <strong>Flag Reason:</strong> {call.flag_reason}
            </div>
          )}
          {call.rep_notes && (
            <div className="p-3 bg-muted/40 rounded-lg text-sm">
              <strong>Rep Notes:</strong> {call.rep_notes}
            </div>
          )}
        </div>

        {/* AI Analysis */}
        <div className="bg-card rounded-xl shadow-sm border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <Brain className="w-4 h-4" /> AI Analysis
            </h3>
            <button
              onClick={runAnalysis}
              disabled={analyzing || !call.transcript_text}
              title={!call.transcript_text ? 'No transcript available yet' : analysis ? 'Re-run AI analysis' : 'Run AI analysis'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {analysis ? 'Re-run' : 'Run analysis'}
            </button>
          </div>
          {analyzeError && (
            <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">{analyzeError}</div>
          )}
          {analysis ? (
            <div className="space-y-3 text-sm">
              {(analysis.ai_summary || '').toLowerCase().startsWith('[no audio]') && (
                <div className="p-2 rounded bg-warning/10 text-warning text-xs flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>This analysis was generated without a real audio transcript — based only on the AI intake summary and rep notes. Rep performance was not evaluated.</span>
                </div>
              )}
              <div className="p-3 bg-accent/10 rounded-lg">{analysis.ai_summary}</div>
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-muted-foreground">Category:</span> {analysis.ai_category}</div>
                <div>
                  <span className="text-muted-foreground">Success:</span>{' '}
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    analysis.ai_success_status === 'successful' ? 'bg-success/15 text-success' :
                    analysis.ai_success_status === 'partially_successful' ? 'bg-warning/15 text-warning' :
                    'bg-destructive/15 text-destructive'
                  }`}>{analysis.ai_success_status}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Sentiment:</span>{' '}
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    analysis.ai_sentiment === 'positive' ? 'bg-success/15 text-success' :
                    analysis.ai_sentiment === 'neutral' ? 'bg-muted text-foreground' :
                    'bg-destructive/15 text-destructive'
                  }`}>{analysis.ai_sentiment}</span>
                </div>
                <div><span className="text-muted-foreground">Confidence:</span> {Math.round(analysis.ai_confidence_score * 100)}%</div>
              </div>
              {analysis.ai_wasted_time_flag && (
                <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/30">
                  <AlertTriangle className="w-4 h-4 text-destructive inline mr-1" />
                  <strong>Wasted Time Detected:</strong> {analysis.ai_flag_reason}
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8">
              {call.transcript_text
                ? 'No AI analysis yet — click Run analysis above.'
                : 'No transcript available yet. AI analysis runs automatically once a transcript is recorded.'}
            </p>
          )}
        </div>
      </div>

      {/* Recording */}
      {(recordingSignedUrl || call.recording_storage_path) && (
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Mic className="w-4 h-4" /> Recording
            </h3>
            {call.recording_storage_path && (
              <button
                onClick={runTranscribe}
                disabled={transcribing}
                title={call.transcript_text ? 'Re-transcribe and re-run AI analysis' : 'Transcribe recording and run AI analysis'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {transcribing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {call.transcript_text ? 'Re-transcribe' : 'Transcribe & analyze'}
              </button>
            )}
          </div>
          {transcribeError && (
            <div className="p-2 mb-3 rounded bg-destructive/10 text-destructive text-xs">{transcribeError}</div>
          )}
          {recordingSignedUrl ? (
            <audio controls src={recordingSignedUrl} className="w-full" />
          ) : (
            <p className="text-xs text-muted-foreground">Recording stored but signed URL unavailable.</p>
          )}
        </div>
      )}

      {/* Transcript */}
      {call.transcript_text && (
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4" /> Transcript
          </h3>
          <div className="bg-muted/40 rounded-lg p-4 max-h-96 overflow-y-auto text-sm whitespace-pre-wrap">
            {call.transcript_text}
          </div>
        </div>
      )}
    </div>
  );
}
