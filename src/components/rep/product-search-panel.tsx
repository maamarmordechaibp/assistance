'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Mail, FileText, Search, RefreshCw, ShoppingBag } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Search {
  id: string;
  query: string | null;
  site: string | null;
  source_url: string | null;
  options_count: number;
  sent_email: string | null;
  sent_at: string | null;
  created_at: string;
}

export default function ProductSearchPanel({
  customerId,
  customerEmail,
  callId,
}: {
  customerId: string;
  customerEmail?: string | null;
  callId?: string | null;
}) {
  const [searches, setSearches] = useState<Search[]>([]);
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [emailing, setEmailing] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (customerId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  async function load() {
    setLoading(true);
    const res = await edgeFn('product-search', { params: { action: 'list', customerId } });
    if (res.ok) {
      const data = await res.json();
      setSearches(data.searches || []);
    }
    setLoading(false);
  }

  async function scrape() {
    if (!query.trim()) {
      toast.error('Enter a search query first');
      return;
    }
    setScraping(true);
    const res = await edgeFn('product-search', {
      method: 'POST',
      body: JSON.stringify({ action: 'scrape', customerId, callId, query: query.trim() }),
    });
    setScraping(false);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || 'Scrape failed — make sure customer browser is on a search results page');
      return;
    }
    const data = await res.json();
    toast.success(`Captured ${data.options?.length ?? 0} options`);
    setQuery('');
    void load();
  }

  async function emailSearch(s: Search) {
    if (!customerEmail) {
      toast.error('Customer has no email on file');
      return;
    }
    setEmailing(s.id);
    const res = await edgeFn('product-search', {
      method: 'POST',
      body: JSON.stringify({ action: 'email', searchId: s.id, toEmail: customerEmail }),
    });
    setEmailing(null);
    if (res.ok) {
      toast.success(`Sent to ${customerEmail}`);
      void load();
    } else {
      toast.error('Email failed');
    }
  }

  function openPdf(s: Search) {
    // PDF endpoint requires the auth header, so fetch via edgeFn and open as blob.
    void (async () => {
      const res = await edgeFn('product-search', { params: { action: 'pdf', searchId: s.id } });
      if (!res.ok) return toast.error('Could not load PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    })();
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <ShoppingBag className="w-4 h-4" /> Product search
        </h3>
        <button
          type="button"
          onClick={load}
          className="p-1 rounded hover:bg-gray-100"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search query (run from the customer browser results page)"
            className="flex-1 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => { if (e.key === 'Enter') void scrape(); }}
          />
          <button
            onClick={scrape}
            disabled={scraping}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {scraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Capture
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
        ) : searches.length === 0 ? (
          <div className="text-xs text-gray-500 italic py-2">
            No captured searches yet. Browse to a results page in the customer browser, type a label here, and click Capture.
          </div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {searches.map((s) => (
              <div key={s.id} className="border rounded p-2 text-sm flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{s.query || s.site || 'Untitled'}</div>
                  <div className="text-xs text-gray-500 flex gap-2">
                    <span>{s.options_count} options</span>
                    <span>•</span>
                    <span>{new Date(s.created_at).toLocaleString()}</span>
                    {s.sent_at && <span className="text-green-600">• Emailed</span>}
                  </div>
                </div>
                <button
                  onClick={() => openPdf(s)}
                  className="p-1.5 rounded hover:bg-blue-50 text-blue-600"
                  title="Open PDF"
                >
                  <FileText className="w-4 h-4" />
                </button>
                <button
                  onClick={() => emailSearch(s)}
                  disabled={!customerEmail || emailing === s.id}
                  className="p-1.5 rounded hover:bg-blue-50 text-blue-600 disabled:opacity-40"
                  title={customerEmail ? `Email to ${customerEmail}` : 'No customer email on file'}
                >
                  {emailing === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
