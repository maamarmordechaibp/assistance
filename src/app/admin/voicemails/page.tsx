'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2, Archive, Play, Mail, MailOpen, RefreshCw } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Voicemail {
  id: string;
  customer_id: string | null;
  caller_phone: string | null;
  mailbox: string;
  recording_storage_path: string | null;
  transcript_text: string | null;
  duration_seconds: number | null;
  played_at: string | null;
  archived_at: string | null;
  created_at: string;
  customers: { full_name: string } | null;
}

export default function VoicemailsPage() {
  const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    void fetchVoicemails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  async function fetchVoicemails() {
    setLoading(true);
    const res = await edgeFn('voicemails', { params: { includeArchived: includeArchived ? '1' : '0' } });
    if (res.ok) {
      const data = await res.json();
      setVoicemails(data.voicemails || []);
    } else {
      toast.error('Failed to load voicemails');
    }
    setLoading(false);
  }

  async function play(vm: Voicemail) {
    if (!vm.recording_storage_path) {
      toast.error('No recording available');
      return;
    }
    setPlayingId(vm.id);
    const res = await edgeFn('voicemails', { params: { action: 'signed-url', id: vm.id } });
    if (!res.ok) {
      toast.error('Could not load audio');
      setPlayingId(null);
      return;
    }
    const data = await res.json();
    setAudioUrl(data.url);
    if (!vm.played_at) {
      await edgeFn('voicemails', { method: 'PATCH', body: JSON.stringify({ id: vm.id, played: true }) });
      setVoicemails((prev) => prev.map((v) => (v.id === vm.id ? { ...v, played_at: new Date().toISOString() } : v)));
    }
  }

  async function togglePlayed(vm: Voicemail) {
    const next = vm.played_at ? false : true;
    const res = await edgeFn('voicemails', { method: 'PATCH', body: JSON.stringify({ id: vm.id, played: next }) });
    if (!res.ok) return toast.error('Failed');
    setVoicemails((prev) => prev.map((v) => (v.id === vm.id ? { ...v, played_at: next ? new Date().toISOString() : null } : v)));
  }

  async function archive(vm: Voicemail) {
    const next = vm.archived_at ? false : true;
    const res = await edgeFn('voicemails', { method: 'PATCH', body: JSON.stringify({ id: vm.id, archived: next }) });
    if (!res.ok) return toast.error('Failed');
    if (!includeArchived && next) {
      setVoicemails((prev) => prev.filter((v) => v.id !== vm.id));
    } else {
      setVoicemails((prev) => prev.map((v) => (v.id === vm.id ? { ...v, archived_at: next ? new Date().toISOString() : null } : v)));
    }
    toast.success(next ? 'Archived' : 'Restored');
  }

  async function remove(vm: Voicemail) {
    if (!confirm('Permanently delete this voicemail?')) return;
    const res = await edgeFn('voicemails', { method: 'DELETE', params: { id: vm.id } });
    if (!res.ok) return toast.error('Failed to delete');
    setVoicemails((prev) => prev.filter((v) => v.id !== vm.id));
    if (playingId === vm.id) {
      setAudioUrl(null);
      setPlayingId(null);
    }
    toast.success('Deleted');
  }

  function fmtDuration(s: number | null) {
    if (!s) return '—';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Voicemails</h1>
        <div className="flex items-center gap-3">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button
            type="button"
            onClick={() => fetchVoicemails()}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {audioUrl && (
        <div className="bg-white border rounded p-3 sticky top-2 z-10 shadow-sm">
          <audio controls autoPlay src={audioUrl} className="w-full" />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : voicemails.length === 0 ? (
        <div className="bg-white rounded border p-10 text-center text-gray-500">
          No voicemails yet. Messages left on the Yiddish admin office line will appear here.
        </div>
      ) : (
        <div className="bg-white rounded border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="p-3 w-10"></th>
                <th className="p-3">Caller</th>
                <th className="p-3">Mailbox</th>
                <th className="p-3">Received</th>
                <th className="p-3">Duration</th>
                <th className="p-3">Transcript</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {voicemails.map((vm) => {
                const unread = !vm.played_at;
                return (
                  <tr key={vm.id} className={unread ? 'border-t font-semibold' : 'border-t'}>
                    <td className="p-3">
                      <button onClick={() => togglePlayed(vm)} title={unread ? 'Mark as read' : 'Mark as unread'}>
                        {unread ? <Mail className="w-4 h-4 text-blue-600" /> : <MailOpen className="w-4 h-4 text-gray-400" />}
                      </button>
                    </td>
                    <td className="p-3">
                      <div>{vm.customers?.full_name || 'Unknown'}</div>
                      <div className="text-xs text-gray-500 font-normal">{vm.caller_phone || '—'}</div>
                    </td>
                    <td className="p-3 capitalize">{vm.mailbox}</td>
                    <td className="p-3 font-normal">{new Date(vm.created_at).toLocaleString()}</td>
                    <td className="p-3 font-normal">{fmtDuration(vm.duration_seconds)}</td>
                    <td className="p-3 max-w-md font-normal text-gray-700">
                      {vm.transcript_text ? (
                        <div className="line-clamp-3 text-xs whitespace-pre-wrap">{vm.transcript_text}</div>
                      ) : (
                        <span className="text-xs text-gray-400 italic">Transcribing…</span>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => play(vm)}
                          disabled={!vm.recording_storage_path}
                          className="p-1.5 rounded hover:bg-blue-50 text-blue-600 disabled:opacity-40"
                          title="Play"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => archive(vm)}
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-600"
                          title={vm.archived_at ? 'Restore' : 'Archive'}
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => remove(vm)}
                          className="p-1.5 rounded hover:bg-red-50 text-red-600"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
