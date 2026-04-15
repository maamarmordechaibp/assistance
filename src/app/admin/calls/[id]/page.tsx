'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatDuration, formatDateTime, formatPhone } from '@/lib/utils';
import { ArrowLeft, Clock, User, Phone, FileText, Brain, AlertTriangle, Loader2 } from 'lucide-react';
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
  const supabase = createClient();

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
        .single();

      if (analysisData) setAnalysis(analysisData as Analysis);
      setLoading(false);
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!call) {
    return <div className="text-center py-12 text-gray-500">Call not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/calls" className="p-2 rounded-lg hover:bg-gray-100">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h2 className="text-xl font-semibold">Call Detail</h2>
        {call.flag_status === 'flagged' && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
            <AlertTriangle className="w-3 h-3" />
            Flagged
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Call Info */}
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Phone className="w-4 h-4" /> Call Information
          </h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-gray-500">Customer:</span> {call.customer?.full_name || 'Unknown'}</div>
            <div><span className="text-gray-500">Phone:</span> {formatPhone(call.inbound_phone)}</div>
            <div><span className="text-gray-500">Rep:</span> {call.rep?.full_name || 'N/A'}</div>
            <div><span className="text-gray-500">Category:</span> {call.task_category?.name || 'N/A'}</div>
            <div><span className="text-gray-500">Started:</span> {formatDateTime(call.started_at)}</div>
            <div><span className="text-gray-500">Ended:</span> {call.ended_at ? formatDateTime(call.ended_at) : 'Ongoing'}</div>
            <div>
              <span className="text-gray-500">Duration:</span>{' '}
              {call.total_duration_seconds ? formatDuration(call.total_duration_seconds) : '—'}
            </div>
            <div><span className="text-gray-500">Minutes Billed:</span> {call.minutes_deducted}</div>
            <div><span className="text-gray-500">Extensions:</span> {call.extensions_used}</div>
            <div>
              <span className="text-gray-500">Outcome:</span>{' '}
              {call.outcome_status ? (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  call.outcome_status === 'resolved' ? 'bg-green-100 text-green-800' :
                  call.outcome_status === 'partial' ? 'bg-yellow-100 text-yellow-800' :
                  'bg-red-100 text-red-800'
                }`}>{call.outcome_status}</span>
              ) : '—'}
            </div>
          </div>
          {call.flag_reason && (
            <div className="p-3 bg-red-50 rounded-lg border border-red-200 text-sm">
              <strong>Flag Reason:</strong> {call.flag_reason}
            </div>
          )}
          {call.rep_notes && (
            <div className="p-3 bg-gray-50 rounded-lg text-sm">
              <strong>Rep Notes:</strong> {call.rep_notes}
            </div>
          )}
        </div>

        {/* AI Analysis */}
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Brain className="w-4 h-4" /> AI Analysis
          </h3>
          {analysis ? (
            <div className="space-y-3 text-sm">
              <div className="p-3 bg-blue-50 rounded-lg">{analysis.ai_summary}</div>
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-gray-500">Category:</span> {analysis.ai_category}</div>
                <div>
                  <span className="text-gray-500">Success:</span>{' '}
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    analysis.ai_success_status === 'successful' ? 'bg-green-100 text-green-800' :
                    analysis.ai_success_status === 'partially_successful' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-red-100 text-red-800'
                  }`}>{analysis.ai_success_status}</span>
                </div>
                <div>
                  <span className="text-gray-500">Sentiment:</span>{' '}
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    analysis.ai_sentiment === 'positive' ? 'bg-green-100 text-green-800' :
                    analysis.ai_sentiment === 'neutral' ? 'bg-gray-100 text-gray-800' :
                    'bg-red-100 text-red-800'
                  }`}>{analysis.ai_sentiment}</span>
                </div>
                <div><span className="text-gray-500">Confidence:</span> {Math.round(analysis.ai_confidence_score * 100)}%</div>
              </div>
              {analysis.ai_wasted_time_flag && (
                <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                  <AlertTriangle className="w-4 h-4 text-red-500 inline mr-1" />
                  <strong>Wasted Time Detected:</strong> {analysis.ai_flag_reason}
                </div>
              )}
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">No AI analysis available for this call.</p>
          )}
        </div>
      </div>

      {/* Transcript */}
      {call.transcript_text && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4" /> Transcript
          </h3>
          <div className="bg-gray-50 rounded-lg p-4 max-h-96 overflow-y-auto text-sm whitespace-pre-wrap">
            {call.transcript_text}
          </div>
        </div>
      )}
    </div>
  );
}
