'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMinutes, formatDuration, formatPhone } from '@/lib/utils';
import { toast } from 'sonner';
import Softphone from '@/components/softphone/softphone';
import ProductSearchPanel from '@/components/rep/product-search-panel';
import OrdersPanel from '@/components/rep/orders-panel';
import EmailInbox from '@/components/rep/email-inbox';
import ForwardingSetupCard from '@/components/rep/forwarding-setup-card';
import BrowserLockBadge from '@/components/rep/browser-lock-badge';
import { LauncherSetup } from '@/components/rep/launcher-setup';
import {
  Phone,
  PhoneOff,
  PhoneMissed,
  Clock,
  User,
  Lock,
  Copy,
  Plus,
  CheckCircle,
  AlertTriangle,
  Loader2,
  TimerReset,
  X,
  UserCheck,
  UserPlus,
  Sparkles,
  ExternalLink,
  BookMarked,
  ChevronDown,
  ChevronUp,
  Globe,
  FileText,
  Mail,
  Download,
  FileDown,
  Search,
  ShoppingBag,
  Maximize2,
  Minimize2,
  RefreshCw,
} from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/primitives';

interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  email: string | null;
  assigned_email: string | null;
  personal_email: string | null;
  forwarding_verified_at: string | null;
  auto_forward_mode?: 'off' | 'all' | 'allowlist' | null;
  auto_forward_senders?: string[] | null;
  current_balance_minutes: number;
  total_minutes_purchased?: number;
  internal_notes: string | null;
  status: string;
}

interface IntakeBriefSuggestions {
  search_terms?: string[];
  platforms?: string[];
  rep_tip?: string;
}

interface IntakeBriefFinding {
  description: string;
  url: string | null;
  price: string | null;
  platform: string | null;
  notes: string | null;
  found_at: string;
}

interface IntakeBrief {
  category?: string;
  summary: string;
  suggestions: IntakeBriefSuggestions;
  previous_finding: IntakeBriefFinding | null;
}

interface ActiveCall {
  id: string;
  customer_id: string | null;
  call_sid: string;
  started_at: string;
  connected_at: string | null;
  billable_started_at?: string | null;
  customer?: Customer;
  ai_intake_brief?: IntakeBrief | null;
  ai_intake_completed?: boolean;
}

interface Credential {
  id: string;
  service_name: string;
  username: string | null;
  created_at: string;
}

interface TaskCategory {
  id: string;
  name: string;
}

export default function RepDashboard() {
  const [repStatus, setRepStatus] = useState<string>('offline');
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [callTimer, setCallTimer] = useState(0);
  const [repNotes, setRepNotes] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [launcherSetupOpen, setLauncherSetupOpen] = useState(false);
  const [webrtcToken, setWebrtcToken] = useState<string | null>(null);
  const [signalwireProjectId, setSignalwireProjectId] = useState<string | null>(null);
  const [signalwireSpaceUrl, setSignalwireSpaceUrl] = useState<string | null>(null);
  const [signalwireIdentity, setSignalwireIdentity] = useState<string | null>(null);
  const [repId, setRepId] = useState<string | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<string>('');
  const [extensionsUsed, setExtensionsUsed] = useState(0);
  const [maxExtensions, setMaxExtensions] = useState(2);
  const [extensionMinutes, setExtensionMinutes] = useState(5);
  const [showAddCredential, setShowAddCredential] = useState(false);
  const [newCred, setNewCred] = useState({ serviceName: '', username: '', password: '' });
  const [showNameCapture, setShowNameCapture] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [showLogFinding, setShowLogFinding] = useState(false);
  const [newFinding, setNewFinding] = useState({ description: '', itemUrl: '', itemPrice: '', itemPlatform: '', itemNotes: '' });
  const [savingFinding, setSavingFinding] = useState(false);
  // Browserbase customer browser
  const [bbLiveUrl, setBbLiveUrl] = useState<string | null>(null);
  const [bbLoading, setBbLoading] = useState(false);
  const [bbExpanded, setBbExpanded] = useState(false);
  const [bbFullscreen, setBbFullscreen] = useState(false);
  type BbTab = { id: string; url: string; title: string; faviconUrl?: string; debuggerFullscreenUrl: string };
  const [bbTabs, setBbTabs] = useState<BbTab[]>([]);
  const [bbActiveTabId, setBbActiveTabId] = useState<string | null>(null);
  const [bbTabsLoading, setBbTabsLoading] = useState(false);

  // Rep's own personal browser (no customer required)
  const [rbLiveUrl, setRbLiveUrl] = useState<string | null>(null);
  const [rbLoading, setRbLoading] = useState(false);
  const [rbOpen, setRbOpen] = useState(false);
  const [rbFullscreen, setRbFullscreen] = useState(false);
  const [rbTabs, setRbTabs] = useState<BbTab[]>([]);
  const [rbActiveTabId, setRbActiveTabId] = useState<string | null>(null);
  // Track previous brief to fire toast only once when it arrives
  const prevBriefRef = useRef<IntakeBrief | null>(null);
  // makeCallFn is wired from the softphone onReady callback so other pages can use it
  const makeCallFnRef = useRef<((to: string) => Promise<void>) | null>(null);

  const supabase = createClient();

  // Fetch initial data
  useEffect(() => {
    async function init() {
      try {
        let myRepId: string | null = null;
        const res = await edgeFn('reps-me');
        // If unauthorized, edgeFn handles signout+redirect — stop here
        if (res.status === 401) return;
        if (res.ok) {
          const data = await res.json();
          setRepStatus(data.rep?.status || 'offline');
          if (data.rep?.id) { setRepId(data.rep.id); myRepId = data.rep.id; }
          if (data.webrtcToken) setWebrtcToken(data.webrtcToken);
          if (data.signalwireProjectId) setSignalwireProjectId(data.signalwireProjectId);
          if (data.signalwireSpaceUrl) setSignalwireSpaceUrl(data.signalwireSpaceUrl);
          if (data.signalwireIdentity) setSignalwireIdentity(data.signalwireIdentity);
        }

        // Load settings for call extensions
        const settingsRes = await edgeFn('settings');
        if (settingsRes.status === 401) return;
        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          const settingsList = settingsData.settings || [];
          const extMin = settingsList.find((s: { key: string }) => s.key === 'extension_minutes');
          const maxExt = settingsList.find((s: { key: string }) => s.key === 'max_extensions_per_call');
          if (extMin) setExtensionMinutes(Number(JSON.parse(extMin.value)));
          if (maxExt) setMaxExtensions(Number(JSON.parse(maxExt.value)));
        }

        const { data: cats } = await supabase
          .from('task_categories')
          .select('id, name')
          .eq('is_active', true)
          .order('sort_order');

        if (cats) setCategories(cats);

        // Restore in-progress call on page refresh. A call is only restored
        // when (a) THIS rep is assigned, (b) ended_at is null, and
        // (c) it was connected within the last 30 minutes — otherwise it
        // is treated as a stale ghost call and ignored.
        if (myRepId) {
          try {
            const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: ongoing } = await supabase
              .from('calls')
              .select('*')
              .eq('rep_id', myRepId)
              .is('ended_at', null)
              .not('connected_at', 'is', null)
              .gte('connected_at', cutoff)
              .order('connected_at', { ascending: false })
              .limit(1);
            const mine = (ongoing || [])[0];
            if (mine) {
              setActiveCall(mine as ActiveCall);
              if (mine.customer_id) loadCustomer(mine.customer_id);
              if (mine.rep_notes) setRepNotes(mine.rep_notes);
              if (mine.task_category_id) setSelectedCategory(mine.task_category_id);
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        console.error('Init error:', err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Auto-refresh the SignalWire SAT token every 45 minutes (TTL is 60 min).
  // Without this the softphone silently disconnects and calls get SIP 408.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await edgeFn('reps-me');
        if (res.ok) {
          const data = await res.json();
          if (data.webrtcToken) setWebrtcToken(data.webrtcToken);
        }
      } catch { /* ignore — will retry in next interval */ }
    }, 45 * 60 * 1000); // 45 minutes
    return () => clearInterval(interval);
  }, []);

  // Auto-dial when arriving from /admin/calls or /rep/history with ?dial=<phone>
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const dial = sp.get('dial');
    const preloadCustomerId = sp.get('customerId');
    if (!dial) return;

    // Pre-load the customer profile so the rep sees full context the moment
    // the customer answers — before the call even connects.
    if (preloadCustomerId) {
      loadCustomer(preloadCustomerId);
    }

    let fired = false;
    const deadline = Date.now() + 30_000;
    const tick = setInterval(async () => {
      if (fired) return;
      if (makeCallFnRef.current) {
        fired = true;
        clearInterval(tick);
        try { window.history.replaceState({}, '', window.location.pathname); } catch { /* noop */ }
        try {
          toast.info(`Calling ${dial}…`);
          await makeCallFnRef.current(dial);
        } catch (err) {
          toast.error('Call failed: ' + (err instanceof Error ? err.message : String(err)));
        }
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        toast.error('Softphone did not initialize in time. Please dial manually.');
      }
    }, 500);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to real-time call updates
  useEffect(() => {
    const channel = supabase
      .channel('rep-calls')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'calls' },
        (payload) => {
          const call = payload.new as ActiveCall;
          if (call && payload.eventType === 'INSERT') {
            setActiveCall(call);
            loadCustomer(call.customer_id);
          } else if (call && payload.eventType === 'UPDATE') {
            setActiveCall(call);
            // If customer wasn't loaded yet (e.g. brief arrived before customer fetch)
            if (call.customer_id) loadCustomer(call.customer_id);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Call timer — only counts time AFTER the rep clicks "Confirm & Continue".
  // The customer is not billed for the chat that establishes whether they
  // still need help (they might say no and we let them go).
  useEffect(() => {
    const billableStart = activeCall?.billable_started_at;
    if (!billableStart) {
      setCallTimer(0);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Math.floor(
        (Date.now() - new Date(billableStart).getTime()) / 1000
      );
      setCallTimer(elapsed);
    }, 1000);
    return () => clearInterval(interval);
  }, [activeCall?.billable_started_at]);

  // Stable callback — must not be inline in JSX or it recreates on every render,
  // which would tear down and restart the Relay WebSocket connection each time.
  // Show toast when AI intake brief arrives
  useEffect(() => {
    const brief = activeCall?.ai_intake_brief as IntakeBrief | null | undefined;
    if (brief && !prevBriefRef.current) {
      toast.info(`AI Brief: ${brief.summary?.slice(0, 100)}${(brief.summary?.length ?? 0) > 100 ? '…' : ''}`, {
        duration: 7000,
        icon: '🤖',
      });
    }
    prevBriefRef.current = brief ?? null;
  }, [activeCall?.ai_intake_brief]);

  // Pre-fill rep notes from the brief when it arrives (only if notes are empty)
  useEffect(() => {
    const brief = activeCall?.ai_intake_brief as IntakeBrief | null | undefined;
    if (brief?.summary && !repNotes) {
      setRepNotes(`[AI] ${brief.summary}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall?.ai_intake_brief]);

  const handleCallEnded = useCallback(() => {
    // SignalWire signaled the WebRTC leg ended (rep or customer hung up).
    // Stamp the call as ended in the DB so billing stops and the call
    // doesn't get auto-restored on refresh. Fire-and-forget — UI clears
    // immediately regardless of network result.
    setActiveCall((prev) => {
      if (prev?.id) {
        edgeFn('calls', {
          method: 'PATCH',
          body: JSON.stringify({ id: prev.id, endCall: true }),
        }).catch(() => { /* non-fatal — sw-status webhook will catch it */ });
      }
      return null;
    });
    setCustomer(null);
    setCredentials([]);
    setShowLogFinding(false);
    setNewFinding({ description: '', itemUrl: '', itemPrice: '', itemPlatform: '', itemNotes: '' });
    prevBriefRef.current = null;
    setBbLiveUrl(null);
    setBbExpanded(false);
  }, []);

  const loadCustomer = useCallback(async (customerId: string | null) => {
    if (!customerId) {
      setCustomer(null);
      setCredentials([]);
      setShowNameCapture(false);
      setIdentityConfirmed(false);
      return;
    }
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .single();

    if (data) {
      setCustomer(data as Customer);

      // Trigger name capture for new callers or identity confirm for returning
      const isNewCaller = data.full_name.startsWith('Caller ');
      setShowNameCapture(isNewCaller);
      setIdentityConfirmed(false);
      setNewCustomerName('');

      // Load credentials
      const credRes = await edgeFn('vault-credentials', { params: { customerId } });
      if (credRes.ok) {
        const creds = await credRes.json();
        setCredentials(creds);
      }
    }
  }, []);

  const saveCustomerName = async () => {
    if (!customer || !newCustomerName.trim()) return;
    try {
      const res = await edgeFn('customers', {
        method: 'PATCH',
        body: JSON.stringify({ id: customer.id, fullName: newCustomerName.trim() }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCustomer({ ...customer, full_name: updated.full_name });
        setShowNameCapture(false);
        toast.success('Customer name saved');
      } else {
        toast.error('Failed to save name');
      }
    } catch {
      toast.error('Failed to save name');
    }
  };

  const confirmIdentity = async () => {
    setIdentityConfirmed(true);
    // Start the billing meter NOW — server-side timestamp is the source of
    // truth for minute deduction at end-of-call.
    if (activeCall?.id) {
      try {
        const res = await edgeFn('call-outbound', {
          method: 'POST',
          body: JSON.stringify({ action: 'confirm', call_id: activeCall.id }),
        });
        if (res.ok) {
          const data = await res.json();
          setActiveCall(prev => prev ? { ...prev, billable_started_at: data.billable_started_at } : prev);
          toast.success('Customer confirmed — billing started');
          return;
        }
      } catch { /* fall through to local-only */ }
    }
    // Fallback: still flip local state so the UI moves forward even if the
    // server confirm fails (rare — e.g. inbound queue calls have no
    // call-outbound row). Use connected_at as the meter origin.
    setActiveCall(prev => prev ? {
      ...prev,
      billable_started_at: prev.billable_started_at || prev.connected_at || new Date().toISOString(),
    } : prev);
    toast.success('Customer confirmed — billing started');
  };

  const updateStatus = async (status: string) => {
    const res = await edgeFn('reps-me', {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setRepStatus(status);
      // Fetch WebRTC token to enable softphone when available
      if (status === 'available') {
        try {
          const tokenRes = await edgeFn('reps-me');
          if (tokenRes.ok) {
            const data = await tokenRes.json();
            if (data.webrtcToken) setWebrtcToken(data.webrtcToken);
            if (data.signalwireProjectId) setSignalwireProjectId(data.signalwireProjectId);
            if (data.signalwireSpaceUrl) setSignalwireSpaceUrl(data.signalwireSpaceUrl);
            if (data.signalwireIdentity) setSignalwireIdentity(data.signalwireIdentity);
          }
        } catch (err) {
          console.error('Failed to fetch WebRTC token:', err);
        }
      } else if (status === 'offline') {
        setWebrtcToken(null);
      }
    }
  };

  const copyPassword = async (credentialId: string) => {
    if (!activeCall) return;
    try {
      const res = await edgeFn('vault-credentials-copy', {
        method: 'POST',
        body: JSON.stringify({ credentialId, callId: activeCall.id }),
      });
      if (res.ok) {
        const data = await res.json();
        await navigator.clipboard.writeText(data.password);
        setCopiedId(credentialId);
        toast.success('Password copied to clipboard');
        setTimeout(() => setCopiedId(null), 3000);
      } else {
        toast.error('Failed to copy password');
      }
    } catch {
      toast.error('Failed to copy password');
    }
  };

  const selectOutcome = async (outcome: string) => {
    if (!activeCall) return;
    setSelectedOutcome(outcome);
    try {
      await edgeFn('calls', {
        method: 'PATCH',
        body: JSON.stringify({ id: activeCall.id, outcomeStatus: outcome }),
      });
      toast.success(`Call marked as ${outcome}`);
    } catch {
      toast.error('Failed to set outcome');
    }
  };

  const extendCall = async () => {
    if (!activeCall || extensionsUsed >= maxExtensions) return;
    try {
      const res = await edgeFn('calls', {
        method: 'PATCH',
        body: JSON.stringify({
          id: activeCall.id,
          extensionsUsed: extensionsUsed + 1,
        }),
      });
      if (res.ok) {
        setExtensionsUsed((prev) => prev + 1);
        toast.success(`Call extended by ${extensionMinutes} minutes`);
      }
    } catch {
      toast.error('Failed to extend call');
    }
  };

  const logFinding = async () => {
    if (!activeCall || !newFinding.description.trim()) return;
    setSavingFinding(true);
    try {
      const res = await edgeFn('call-findings', {
        method: 'POST',
        body: JSON.stringify({
          callId: activeCall.id,
          customerId: customer?.id || null,
          description: newFinding.description,
          itemUrl: newFinding.itemUrl || undefined,
          itemPrice: newFinding.itemPrice || undefined,
          itemPlatform: newFinding.itemPlatform || undefined,
          itemNotes: newFinding.itemNotes || undefined,
        }),
      });
      if (res.ok) {
        setNewFinding({ description: '', itemUrl: '', itemPrice: '', itemPlatform: '', itemNotes: '' });
        setShowLogFinding(false);
        toast.success('Finding saved — will be suggested in future similar calls');
      } else {
        toast.error('Failed to save finding');
      }
    } catch {
      toast.error('Failed to save finding');
    } finally {
      setSavingFinding(false);
    }
  };

  const addCredential = async () => {
    if (!activeCall || !customer) return;
    if (!newCred.serviceName.trim() || !newCred.password.trim()) {
      toast.error('Service name and password are required');
      return;
    }
    try {
      const res = await edgeFn('vault-credentials', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          serviceName: newCred.serviceName,
          username: newCred.username || null,
          password: newCred.password,
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        setCredentials((prev) => [...prev, saved]);
        setNewCred({ serviceName: '', username: '', password: '' });
        setShowAddCredential(false);
        toast.success('Credential saved to vault');
      } else {
        toast.error('Failed to save credential');
      }
    } catch {
      toast.error('Failed to save credential');
    }
  };

  const endCall = async () => {
    if (!activeCall) return;
    try {
      await edgeFn('calls', {
        method: 'PATCH',
        body: JSON.stringify({
          id: activeCall.id,
          repNotes,
          taskCategoryId: selectedCategory || undefined,
          outcomeStatus: selectedOutcome || undefined,
          endCall: true,
        }),
      });
      toast.success('Call ended. AI analysis will appear in call history shortly.');
    } catch {
      toast.error('Failed to save call notes');
    }
    setActiveCall(null);
    setCustomer(null);
    setCredentials([]);
    setRepNotes('');
    setSelectedCategory('');
    setSelectedOutcome('');
    setCallTimer(0);
    setExtensionsUsed(0);
    setShowNameCapture(false);
    setIdentityConfirmed(false);
    setNewCustomerName('');
    setShowLogFinding(false);
    setNewFinding({ description: '', itemUrl: '', itemPrice: '', itemPlatform: '', itemNotes: '' });
    prevBriefRef.current = null;
    setBbLiveUrl(null);
    setBbExpanded(false);
    setBbFullscreen(false);
    setBbTabs([]);
    setBbActiveTabId(null);
  };

  // Load the current tab list for this customer's BB session.
  const refreshBbTabs = useCallback(async (customerId: string) => {
    setBbTabsLoading(true);
    try {
      const res = await edgeFn('browser-session', {
        method: 'GET',
        params: { customerId, action: 'tabs' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const pages = (data.pages || []) as BbTab[];
      setBbTabs(pages);
      setBbActiveTabId(prev => {
        if (prev && pages.some(p => p.id === prev)) return prev;
        return pages[0]?.id || null;
      });
    } finally {
      setBbTabsLoading(false);
    }
  }, []);

  // Open a brand-new tab in the customer's browser, then switch to it.
  const openNewBbTab = async () => {
    if (!customer) return;
    try {
      await edgeFn('browser-session', {
        method: 'POST',
        body: JSON.stringify({ action: 'new-tab', customerId: customer.id, url: 'about:blank' }),
      });
      // Give Browserbase a moment to register the new target
      setTimeout(() => { void refreshBbTabs(customer.id); }, 600);
    } catch (err) {
      toast.error('New tab failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const closeBbTab = async (tabId: string) => {
    if (!customer) return;
    try {
      await edgeFn('browser-session', {
        method: 'POST',
        body: JSON.stringify({ action: 'close-tab', customerId: customer.id, targetId: tabId }),
      });
      setTimeout(() => { void refreshBbTabs(customer.id); }, 400);
    } catch { /* ignore */ }
  };

  // ── Rep's personal browser ────────────────────────────────
  const refreshRbTabs = useCallback(async () => {
    try {
      const res = await edgeFn('rep-browser', { method: 'GET', params: { action: 'tabs' } });
      if (!res.ok) return;
      const data = await res.json();
      const pages = (data.pages || []) as BbTab[];
      setRbTabs(pages);
      setRbActiveTabId(prev => {
        if (prev && pages.some(p => p.id === prev)) return prev;
        return pages[0]?.id || null;
      });
    } catch { /* ignore */ }
  }, []);

  // Local launcher (rep's PC): opens real Chrome windows in per-customer profiles.
  // Requires the rep to install tools/offline-browser-launcher (one-time).
  // v2: when a customerId is supplied, the launcher syncs the shared profile
  //     (cookies/logins) from Supabase, holds an exclusive lock while Chrome
  //     is open, and uploads the new state on exit. Falls back to a legacy
  //     local-only profile when only `profile` is given (rep's own browser).
  const LAUNCHER_URL = 'http://localhost:17345';
  const openLocalChrome = async (
    profileOrCustomerId: string,
    url: string,
    label: string,
    opts?: { customerId?: string },
  ) => {
    const customerId = opts?.customerId;
    try {
      let payload: Record<string, unknown>;
      if (customerId) {
        const { data: { session } } = await supabase.auth.getSession();
        const authToken = session?.access_token;
        if (!authToken) throw new Error('Not signed in');
        const fnBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`;
        payload = { customerId, authToken, functionsBaseUrl: fnBase, url };
      } else {
        payload = { profile: profileOrCustomerId, url };
      }
      const res = await fetch(`${LAUNCHER_URL}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        toast.error(`Customer browser is already open by another rep. ${data.detail || ''}`, { duration: 9000 });
        return;
      }
      if (!res.ok) throw new Error(`launcher returned ${res.status}`);
      const data = await res.json().catch(() => ({}));
      toast.success(
        customerId && data.restored
          ? `Opened Chrome — ${label} (restored saved login session)`
          : `Opened Chrome — ${label}`,
      );
    } catch (err) {
      toast.error('Customer Browser is not set up on this PC.', {
        description: String((err as Error).message || err),
        duration: 10000,
        action: {
          label: 'Set up now',
          onClick: () => setLauncherSetupOpen(true),
        },
      });
    }
  };

  const openRepBrowser = async () => {
    setRbLoading(true);
    try {
      const res = await edgeFn('rep-browser', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start rep browser');
      const url = data.session?.live_url;
      if (!url) throw new Error('No live URL returned');
      setRbLiveUrl(url);
      setRbOpen(true);
      setRbFullscreen(true);
      toast.success('Your browser is ready');
      void refreshRbTabs();
    } catch (err) {
      toast.error('Browser failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRbLoading(false);
    }
  };

  const newRbTab = async () => {
    try {
      await edgeFn('rep-browser', { method: 'POST', body: JSON.stringify({ action: 'new-tab', url: 'about:blank' }) });
      setTimeout(() => { void refreshRbTabs(); }, 600);
    } catch { /* ignore */ }
  };

  const closeRbTab = async (tabId: string) => {
    try {
      await edgeFn('rep-browser', { method: 'POST', body: JSON.stringify({ action: 'close-tab', targetId: tabId }) });
      setTimeout(() => { void refreshRbTabs(); }, 400);
    } catch { /* ignore */ }
  };

  const endRepBrowser = async () => {
    try {
      await edgeFn('rep-browser', { method: 'DELETE' });
    } catch { /* ignore */ }
    setRbLiveUrl(null);
    setRbTabs([]);
    setRbActiveTabId(null);
    setRbOpen(false);
    setRbFullscreen(false);
  };

  const printRbPdf = async () => {
    if (!rbActiveTabId) {
      toast.error('No active tab to print.');
      return;
    }
    try {
      toast('Generating PDF…', { duration: 8000 });
      const res = await edgeFn('rep-browser', { method: 'POST', body: JSON.stringify({ action: 'print-pdf', targetId: rbActiveTabId }) });
      const data = await res.json();
      if (!res.ok || !data.pdf) throw new Error(data.error || data.detail || 'PDF generation failed');
      const bytes = Uint8Array.from(atob(data.pdf), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const activeTab = rbTabs.find(t => t.id === rbActiveTabId);
      const hostname = activeTab?.url ? (() => { try { return new URL(activeTab.url).hostname; } catch { return 'page'; } })() : 'page';
      a.download = `${hostname}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('PDF failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Poll tab list for the rep browser while open
  useEffect(() => {
    if (!rbLiveUrl) return;
    const iv = setInterval(() => { void refreshRbTabs(); }, 6000);
    return () => clearInterval(iv);
  }, [rbLiveUrl, refreshRbTabs]);

  // Open / reuse a customer browser session for the active call.
  const openCustomerBrowser = async () => {
    if (!activeCall || !customer) return;
    setBbLoading(true);
    try {
      const res = await edgeFn('browser-session', {
        method: 'POST',
        body: JSON.stringify({ customerId: customer.id, callId: activeCall.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start browser');
      const url = data.session?.live_url;
      if (!url) throw new Error('No live URL returned');
      setBbLiveUrl(url);
      setBbExpanded(true);
      toast.success("Customer's browser is ready");
      // Load the tab list for this session (there will be at least one default page)
      void refreshBbTabs(customer.id);
    } catch (err) {
      toast.error('Browser failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBbLoading(false);
    }
  };

  // While the browser is open, refresh tab list every 6s so new tabs opened
  // inside the page (e.g. links with target="_blank") show up in our tab bar.
  useEffect(() => {
    if (!bbLiveUrl || !customer) return;
    const iv = setInterval(() => { void refreshBbTabs(customer.id); }, 6000);
    return () => clearInterval(iv);
  }, [bbLiveUrl, customer, refreshBbTabs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="size-8 animate-spin text-accent" />
      </div>
    );
  }

  const statusDot =
    repStatus === 'available' ? 'bg-success'
    : repStatus === 'on_call' ? 'bg-warning'
    : repStatus === 'busy' ? 'bg-destructive'
    : 'bg-muted-foreground/40';

  return (
    <div className="space-y-6">
      <LauncherSetup open={launcherSetupOpen} onOpenChange={setLauncherSetupOpen} />
      {/* Status Bar */}
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${statusDot} ${repStatus === 'on_call' ? 'pulse-ring' : ''}`} />
              <span className="text-sm font-medium capitalize text-foreground">
                {repStatus.replace('_', ' ')}
              </span>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <span className="text-xs text-muted-foreground">Rep workspace</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={repStatus === 'available' ? 'success' : 'outline'}
              onClick={() => updateStatus('available')}
            >
              Available
            </Button>
            <Button
              size="sm"
              variant={repStatus === 'busy' ? 'destructive' : 'outline'}
              onClick={() => updateStatus('busy')}
            >
              Busy
            </Button>
            <Button
              size="sm"
              variant={repStatus === 'offline' ? 'secondary' : 'ghost'}
              onClick={() => updateStatus('offline')}
            >
              Offline
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Call Panel */}
        <div className="lg:col-span-2 space-y-6">
          {/* Call Info */}
          <div className="bg-card rounded-xl shadow-sm border p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Phone className="w-5 h-5" />
                Active Call
              </h3>
              {activeCall && (
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 text-lg font-mono" title={activeCall.billable_started_at ? 'Billable time' : 'Billing not started — click Confirm & Continue'}>
                    <Clock className={`w-5 h-5 ${activeCall.billable_started_at ? 'text-muted-foreground' : 'text-warning'}`} />
                    {activeCall.billable_started_at
                      ? formatDuration(callTimer)
                      : <span className="text-sm text-warning font-sans">Awaiting confirmation</span>}
                  </div>
                  <button
                    onClick={endCall}
                    className="flex items-center gap-2 bg-destructive text-white px-4 py-2 rounded-lg hover:bg-destructive/90 transition"
                  >
                    <PhoneOff className="w-4 h-4" />
                    End Call
                  </button>
                </div>
              )}
            </div>

            {activeCall ? (
              <div className="space-y-4">
                {/* Customer Screen Pop */}
                {customer ? (
                  <div className="bg-accent/10 rounded-lg p-4 border border-accent/30">
                    <div className="flex items-center gap-2 mb-3">
                      <User className="w-5 h-5 text-accent" />
                      <span className="font-semibold text-lg">{customer.full_name}</span>
                      <span
                        className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
                          customer.status === 'active'
                            ? 'bg-success/15 text-success'
                            : customer.status === 'flagged'
                            ? 'bg-destructive/15 text-destructive'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        {customer.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Phone:</span>{' '}
                        {formatPhone(customer.primary_phone)}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Email:</span>{' '}
                        {customer.email || 'N/A'}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Balance:</span>{' '}
                        <span
                          className={`font-semibold ${
                            customer.current_balance_minutes <= 0
                              ? 'text-destructive'
                              : customer.current_balance_minutes <= 5
                              ? 'text-warning'
                              : 'text-success'
                          }`}
                        >
                          {formatMinutes(customer.current_balance_minutes)}
                        </span>
                      </div>
                    </div>
                    {customer.internal_notes && (
                      <div className="mt-3 p-2 bg-warning/10 rounded border border-warning/30 text-sm">
                        <AlertTriangle className="w-4 h-4 text-warning inline mr-1" />
                        {customer.internal_notes}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-muted/40 rounded-lg p-4 border text-muted-foreground text-center">
                    <PhoneMissed className="w-8 h-8 mx-auto mb-2" />
                    Unknown caller — no customer profile found
                  </div>
                )}

                {/* No-minutes / Low-balance banner — prompts rep to collect payment */}
                {customer && customer.current_balance_minutes <= 0 && (
                  <div className="bg-destructive/10 rounded-lg p-4 border-2 border-destructive/40">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-destructive text-white text-xs font-bold">!</span>
                      <span className="font-semibold text-destructive">
                        {(customer.total_minutes_purchased ?? 0) > 0
                          ? 'No minutes remaining'
                          : 'New caller — no package yet'}
                      </span>
                    </div>
                    <p className="text-sm text-destructive mb-3">
                      {(customer.total_minutes_purchased ?? 0) > 0
                        ? 'This customer has $0 balance. Offer to top up before starting work.'
                        : 'This is a first-time caller with no package. Offer a package and collect payment before starting work.'}
                    </p>
                    <a
                      href={`/rep/payments?customerId=${customer.id}&lock=1`}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-destructive text-white text-sm font-medium rounded-lg hover:bg-destructive/90"
                    >
                      Process Payment →
                    </a>
                  </div>
                )}

                {/* Name Capture Popup — new callers */}
                {customer && showNameCapture && (
                  <div className="bg-accent/10 rounded-lg p-4 border-2 border-accent/40">
                    <div className="flex items-center gap-2 mb-2">
                      <UserPlus className="w-5 h-5 text-accent" />
                      <span className="font-semibold text-accent">New Caller — Please ask for their name</span>
                    </div>
                    <p className="text-sm text-accent mb-3">
                      This is a first-time caller. Ask them: &quot;May I have your name for our records?&quot;
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={newCustomerName}
                        onChange={(e) => setNewCustomerName(e.target.value)}
                        placeholder="Enter customer's name..."
                        className="flex-1 rounded-lg border border-accent/40 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        onKeyDown={(e) => e.key === 'Enter' && saveCustomerName()}
                      />
                      <button
                        onClick={saveCustomerName}
                        disabled={!newCustomerName.trim()}
                        className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition disabled:bg-muted disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setShowNameCapture(false)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground"
                        title="Dismiss"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Confirm & Continue gate — billing only starts AFTER the rep
                    confirms with the customer that they still need help. The
                    customer might decline ("no thanks, I no longer need it"),
                    in which case the rep ends the call without billing. */}
                {activeCall && !activeCall.billable_started_at && !showNameCapture && (
                  <div className="bg-warning/10 rounded-lg p-4 border-2 border-warning/40">
                    <div className="flex items-center gap-2 mb-2">
                      <UserCheck className="w-5 h-5 text-warning" />
                      <span className="font-semibold text-warning">Confirm with the customer before billing starts</span>
                    </div>
                    <p className="text-sm text-warning mb-3">
                      {customer && !customer.full_name.startsWith('Caller ')
                        ? <>Verify: &quot;Am I speaking with <strong>{customer.full_name}</strong>, and do you still need help today?&quot;</>
                        : <>Confirm with the caller that they still need assistance before the minute meter starts.</>}
                    </p>
                    <p className="text-xs text-warning mb-3">
                      The customer is not billed until you click below. If they decline, end the call instead.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={confirmIdentity}
                        className="px-4 py-2 bg-success text-white rounded-lg text-sm font-medium hover:bg-success/90 transition"
                      >
                        Confirm &amp; Continue
                      </button>
                    </div>
                  </div>
                )}

                {/* AI Intake Brief */}
                {activeCall?.ai_intake_brief && (
                  <div className="bg-warning/10 rounded-lg p-4 border border-warning/30 space-y-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-warning" />
                      <span className="font-semibold text-warning">AI Intake Brief</span>
                      {activeCall.ai_intake_brief.category && (
                        <span className="ml-auto text-xs bg-warning/20 text-warning px-2 py-0.5 rounded-full capitalize">
                          {activeCall.ai_intake_brief.category}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-warning">{activeCall.ai_intake_brief.summary}</p>

                    {/* Search terms — click to copy */}
                    {(activeCall.ai_intake_brief.suggestions?.search_terms?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-xs font-medium text-warning mb-1.5">Search terms:</p>
                        <div className="flex flex-wrap gap-1">
                          {activeCall.ai_intake_brief.suggestions.search_terms!.map((term, i) => (
                            <button
                              key={i}
                              onClick={() => { navigator.clipboard.writeText(term); toast.success('Copied!'); }}
                              className="text-xs bg-card border border-warning/40 text-warning px-2 py-0.5 rounded hover:bg-warning/15 transition"
                              title="Click to copy"
                            >
                              {term}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Platforms */}
                    {(activeCall.ai_intake_brief.suggestions?.platforms?.length ?? 0) > 0 && (
                      <div className="flex items-center gap-2 text-xs text-warning">
                        <span className="font-medium">Check:</span>
                        {activeCall.ai_intake_brief.suggestions.platforms!.join(' · ')}
                      </div>
                    )}

                    {/* Rep tip */}
                    {activeCall.ai_intake_brief.suggestions?.rep_tip && (
                      <div className="text-xs bg-warning/15 rounded p-2 text-warning">
                        <span className="font-medium">Tip: </span>
                        {activeCall.ai_intake_brief.suggestions.rep_tip}
                      </div>
                    )}

                    {/* Previously found item */}
                    {activeCall.ai_intake_brief.previous_finding && (
                      <div className="bg-card rounded p-3 border border-warning/40">
                        <div className="flex items-center gap-1.5 mb-1">
                          <BookMarked className="w-4 h-4 text-warning" />
                          <span className="text-xs font-semibold text-warning uppercase tracking-wide">Previously Found</span>
                          <span className="ml-auto text-xs text-warning">
                            {new Date(activeCall.ai_intake_brief.previous_finding.found_at).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-sm font-medium">{activeCall.ai_intake_brief.previous_finding.description}</p>
                        {activeCall.ai_intake_brief.previous_finding.price && (
                          <p className="text-sm font-semibold text-success">{activeCall.ai_intake_brief.previous_finding.price}</p>
                        )}
                        {activeCall.ai_intake_brief.previous_finding.platform && (
                          <p className="text-xs text-muted-foreground">{activeCall.ai_intake_brief.previous_finding.platform}</p>
                        )}
                        {activeCall.ai_intake_brief.previous_finding.url && (
                          <a
                            href={activeCall.ai_intake_brief.previous_finding.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-accent hover:text-accent mt-1 break-all"
                          >
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                            {activeCall.ai_intake_brief.previous_finding.url.slice(0, 60)}
                            {activeCall.ai_intake_brief.previous_finding.url.length > 60 ? '…' : ''}
                          </a>
                        )}
                        {activeCall.ai_intake_brief.previous_finding.notes && (
                          <p className="text-xs text-muted-foreground mt-1">{activeCall.ai_intake_brief.previous_finding.notes}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Call Notes */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Call Notes
                  </label>
                  <textarea
                    value={repNotes}
                    onChange={(e) => setRepNotes(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Enter notes about this call..."
                  />
                </div>

                {/* Category */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Task Category
                  </label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Select category...</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Outcome */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Outcome</label>
                  <div className="flex gap-2">
                    {(['resolved', 'partial', 'unresolved'] as const).map((outcome) => (
                      <button
                        key={outcome}
                        onClick={() => selectOutcome(outcome)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition capitalize ${
                          selectedOutcome === outcome
                            ? outcome === 'resolved'
                              ? 'bg-success/15 border-success text-success ring-2 ring-success'
                              : outcome === 'partial'
                              ? 'bg-warning/15 border-warning text-warning ring-2 ring-warning'
                              : 'bg-destructive/15 border-destructive text-destructive ring-2 ring-destructive'
                            : 'hover:bg-muted/50'
                        }`}
                      >
                        {outcome === 'resolved' && <CheckCircle className="w-4 h-4 inline mr-1" />}
                        {outcome}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Call Extension */}
                <div className="flex items-center justify-between p-3 bg-warning/10 rounded-lg border border-warning/30">
                  <div className="text-sm">
                    <span className="font-medium text-warning">Extensions:</span>{' '}
                    <span className="text-warning">
                      {extensionsUsed} / {maxExtensions} used
                    </span>
                  </div>
                  <button
                    onClick={extendCall}
                    disabled={extensionsUsed >= maxExtensions}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                      extensionsUsed >= maxExtensions
                        ? 'bg-muted text-muted-foreground/80 cursor-not-allowed'
                        : 'bg-warning text-white hover:bg-warning/90'
                    }`}
                  >
                    <TimerReset className="w-4 h-4" />
                    +{extensionMinutes} min
                  </button>
                </div>

                {/* Log Item Found */}
                {showLogFinding ? (
                  <div className="p-3 bg-success/10 rounded-lg border border-success/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-success flex items-center gap-1.5">
                        <BookMarked className="w-4 h-4" />
                        Log Item Found
                      </span>
                      <button onClick={() => setShowLogFinding(false)} className="text-muted-foreground/80 hover:text-muted-foreground">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <input
                      placeholder="What was found? (e.g. Dell Inspiron 15 laptop)"
                      value={newFinding.description}
                      onChange={(e) => setNewFinding(p => ({ ...p, description: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-success"
                    />
                    <input
                      placeholder="URL (optional)"
                      value={newFinding.itemUrl}
                      onChange={(e) => setNewFinding(p => ({ ...p, itemUrl: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-success"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        placeholder="Price (e.g. $449)"
                        value={newFinding.itemPrice}
                        onChange={(e) => setNewFinding(p => ({ ...p, itemPrice: e.target.value }))}
                        className="rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-success"
                      />
                      <input
                        placeholder="Platform (e.g. Amazon)"
                        value={newFinding.itemPlatform}
                        onChange={(e) => setNewFinding(p => ({ ...p, itemPlatform: e.target.value }))}
                        className="rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-success"
                      />
                    </div>
                    <input
                      placeholder="Notes (optional)"
                      value={newFinding.itemNotes}
                      onChange={(e) => setNewFinding(p => ({ ...p, itemNotes: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-success"
                    />
                    <button
                      onClick={logFinding}
                      disabled={!newFinding.description.trim() || savingFinding}
                      className="w-full bg-success text-white rounded py-1.5 text-sm font-medium hover:bg-success/90 transition disabled:bg-muted disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {savingFinding ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      Save Finding
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowLogFinding(true)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground hover:border-success/50 hover:text-success transition"
                  >
                    <BookMarked className="w-4 h-4" />
                    Log Item Found
                  </button>
                )}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <Phone className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
                <p className="text-lg font-medium">No active call</p>
                <p className="text-sm">Set yourself as Available to receive incoming calls.</p>
              </div>
            )}
          </div>

          {/* Customer Browser (Browserbase) — only visible while on a call */}
          {activeCall && customer && (
            <ProductSearchPanel
              customerId={customer.id}
              customerEmail={customer.email}
              callId={activeCall.id}
            />
          )}

          {/* Orders & tracking — visible on every active call so the rep can
              log a purchase and paste tracking the moment Amazon confirms. */}
          {activeCall && customer && (
            <OrdersPanel customerId={customer.id} callId={activeCall.id} />
          )}

          {/* Customer's email inbox — surfaces OTP codes, order confirmations,
              shipping notices etc. for the customer the rep is on a call with. */}
          {activeCall && customer && (
            <div className="bg-card rounded-xl shadow-sm border p-4">
              <EmailInbox
                customerId={customer.id}
                title={`${customer.full_name}'s emails`}
                description="Inbound + outbound messages on this customer's mailbox. OTP codes are auto-detected."
              />
            </div>
          )}

          {/* Gmail forwarding setup — gives rep a step-by-step script to
              walk a customer through forwarding their personal Gmail
              merchant emails into our assigned mailbox. */}
          {activeCall && customer && (
            <ForwardingSetupCard
              customerId={customer.id}
              assignedEmail={customer.assigned_email}
              personalEmail={customer.personal_email}
              forwardingVerifiedAt={customer.forwarding_verified_at}
              autoForwardMode={customer.auto_forward_mode ?? 'off'}
              autoForwardSenders={customer.auto_forward_senders ?? []}
              onUpdate={(next) =>
                setCustomer({
                  ...customer,
                  personal_email: next.personal_email !== undefined ? next.personal_email : customer.personal_email,
                  auto_forward_mode: next.auto_forward_mode ?? customer.auto_forward_mode,
                  auto_forward_senders: next.auto_forward_senders ?? customer.auto_forward_senders,
                })
              }
            />
          )}

          {/* Customer Browser (Browserbase) — only visible while on a call */}
          {activeCall && customer && (
            <div className={`bg-card rounded-xl shadow-sm border ${bbFullscreen ? 'fixed inset-0 z-50 flex flex-col p-3 rounded-none' : 'p-4'}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                  <Globe className="w-4 h-4" />
                  {customer.full_name}&apos;s Browser
                </h3>
                <div className="flex items-center gap-1.5">
                  {bbLiveUrl && (
                    <>
                      <button
                        onClick={() => customer && refreshBbTabs(customer.id)}
                        disabled={bbTabsLoading}
                        className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1"
                        title="Refresh tab list"
                      >
                        <RefreshCw className={`w-3 h-3 ${bbTabsLoading ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        onClick={openNewBbTab}
                        className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1"
                        title="Open new tab"
                      >
                        <Plus className="w-3 h-3" /> New tab
                      </button>
                      <button
                        onClick={() => setBbFullscreen(v => !v)}
                        className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1"
                        title={bbFullscreen ? 'Exit full screen' : 'Full screen'}
                      >
                        {bbFullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                        {bbFullscreen ? 'Exit' : 'Full'}
                      </button>
                      {!bbFullscreen && (
                        <button
                          onClick={() => setBbExpanded(v => !v)}
                          className="text-xs px-2 py-1 rounded border hover:bg-muted/50"
                        >
                          {bbExpanded ? 'Smaller' : 'Bigger'}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          const active = bbActiveTabId ? bbTabs.find(t => t.id === bbActiveTabId)?.debuggerFullscreenUrl : null;
                          const target = active || bbLiveUrl;
                          if (target) window.open(target, '_blank', 'noopener,noreferrer,width=1600,height=1000');
                        }}
                        className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 flex items-center gap-1"
                        title="Open in a real browser window (much bigger)"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Pop out
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!bbLiveUrl ? (
                <div className="space-y-2">
                  <button
                    onClick={() => openLocalChrome(customer.id, 'https://www.google.com', `${customer.full_name}'s profile`, { customerId: customer.id })}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open Chrome — {customer.full_name}&apos;s profile
                  </button>
                  <BrowserLockBadge customerId={customer.id} />
                </div>
              ) : (
                <div className={`flex flex-col ${bbFullscreen ? 'flex-1 min-h-0' : ''}`}>
                  {/* Tab bar */}
                  {bbTabs.length > 0 && (
                    <div className="flex items-center gap-1 mb-2 overflow-x-auto pb-1 border-b">
                      {bbTabs.map(tab => (
                        <div
                          key={tab.id}
                          className={`group flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-t-md border-b-2 cursor-pointer whitespace-nowrap max-w-[220px] ${
                            bbActiveTabId === tab.id
                              ? 'bg-accent/10 border-accent text-accent font-medium'
                              : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted'
                          }`}
                          onClick={() => setBbActiveTabId(tab.id)}
                          title={tab.url}
                        >
                          {tab.faviconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={tab.faviconUrl} alt="" className="w-3.5 h-3.5 flex-shrink-0" />
                          ) : (
                            <Globe className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/80" />
                          )}
                          <span className="truncate">{tab.title || new URL(tab.url || 'about:blank').hostname || 'New tab'}</span>
                          {bbTabs.length > 1 && (
                            <button
                              onClick={(e) => { e.stopPropagation(); void closeBbTab(tab.id); }}
                              className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 transition"
                              title="Close tab"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <iframe
                    src={
                      bbActiveTabId
                        ? (bbTabs.find(t => t.id === bbActiveTabId)?.debuggerFullscreenUrl || bbLiveUrl)
                        : bbLiveUrl
                    }
                    className={`w-full rounded-lg border bg-muted/40 ${
                      bbFullscreen
                        ? 'flex-1 min-h-0'
                        : bbExpanded
                          ? 'h-[80vh]'
                          : 'h-[600px]'
                    }`}
                    sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"
                    allow="clipboard-read; clipboard-write; autoplay; microphone; camera"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Panel: Softphone + Password Vault */}
        <div className="space-y-6">
          {/* Softphone */}
          <div className="bg-card rounded-xl shadow-sm border p-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Softphone
            </h3>
            <Softphone
              token={webrtcToken}
              projectId={signalwireProjectId}
              host={signalwireSpaceUrl}
              identity={signalwireIdentity}
              repId={repId}
              onCallEnded={handleCallEnded}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onCallClaimed={(payload: any) => {
                // Hydrate the active-call panel immediately so the rep sees
                // the AI brief + customer context the moment they click
                // Answer (i.e. before they even pick up the cellphone).
                if (payload?.call) {
                  setActiveCall(payload.call as ActiveCall);
                }
                if (payload?.customer_id) {
                  loadCustomer(payload.customer_id);
                }
                const brief = payload?.call?.ai_intake_brief as IntakeBrief | null | undefined;
                if (brief?.summary) {
                  toast.info(`AI Brief: ${brief.summary.slice(0, 120)}${brief.summary.length > 120 ? '…' : ''}`, {
                    duration: 10000,
                    icon: '🤖',
                  });
                }
              }}
              onReady={(makeCall) => {
                makeCallFnRef.current = makeCall;
                // Generic global hook used by any rep subpage
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).__repMakeCall = makeCall;
                // Also wire into the callbacks page if it's currently mounted
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const cbRef = (window as any).__repCallbacksMakeCallRef;
                if (cbRef) cbRef.current = makeCall;
              }}
            />
          </div>

          {/* Rep's personal browser — always available, outside customer calls */}
          <div className={`bg-card rounded-xl shadow-sm border ${rbFullscreen ? 'fixed inset-0 z-50 flex flex-col p-3 rounded-none' : 'p-4'}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <Globe className="w-4 h-4" />
                My Browser
              </h3>
              <div className="flex items-center gap-1.5">
                {rbLiveUrl && (
                  <>
                    <button onClick={() => refreshRbTabs()} className="text-xs px-2 py-1 rounded border hover:bg-muted/50" title="Refresh tabs">
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button onClick={newRbTab} className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1" title="New tab">
                      <Plus className="w-3 h-3" /> New
                    </button>
                    <button
                      onClick={() => {
                        const active = rbActiveTabId ? rbTabs.find(t => t.id === rbActiveTabId)?.debuggerFullscreenUrl : null;
                        const target = active || rbLiveUrl;
                        if (target) window.open(target, '_blank', 'noopener,noreferrer,width=1600,height=1000');
                      }}
                      className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 flex items-center gap-1"
                      title="Open in a real browser window (much bigger)"
                    >
                      <ExternalLink className="w-3 h-3" /> Pop out
                    </button>
                    <button
                      onClick={printRbPdf}
                      disabled={!rbActiveTabId}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1 disabled:opacity-40"
                      title="Save current page as PDF"
                    >
                      <FileDown className="w-3 h-3" /> PDF
                    </button>
                    <button onClick={() => setRbFullscreen(v => !v)} className="text-xs px-2 py-1 rounded border hover:bg-muted/50 flex items-center gap-1">
                      {rbFullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                      {rbFullscreen ? 'Exit' : 'Full'}
                    </button>
                    {!rbFullscreen && (
                      <button onClick={() => setRbOpen(v => !v)} className="text-xs px-2 py-1 rounded border hover:bg-muted/50">
                        {rbOpen ? 'Hide' : 'Show'}
                      </button>
                    )}
                    <button onClick={endRepBrowser} className="text-xs px-2 py-1 rounded border hover:bg-destructive/10 text-destructive flex items-center gap-1" title="End session">
                      <X className="w-3 h-3" /> End
                    </button>
                  </>
                )}
              </div>
            </div>
            {!rbLiveUrl ? (
              <div className="space-y-2">
                <button
                  onClick={() => openLocalChrome(`rep-${repId || 'me'}`, 'https://www.google.com', 'your profile')}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Chrome — my profile
                </button>
              </div>
            ) : rbOpen || rbFullscreen ? (
              <div className={`flex flex-col ${rbFullscreen ? 'flex-1 min-h-0' : ''}`}>
                {rbTabs.length > 0 && (
                  <div className="flex items-center gap-1 mb-2 overflow-x-auto pb-1 border-b">
                    {rbTabs.map(tab => (
                      <div
                        key={tab.id}
                        className={`group flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-t-md border-b-2 cursor-pointer whitespace-nowrap max-w-[220px] ${
                          rbActiveTabId === tab.id
                            ? 'bg-accent/10 border-accent text-accent font-medium'
                            : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted'
                        }`}
                        onClick={() => setRbActiveTabId(tab.id)}
                        title={tab.url}
                      >
                        {tab.faviconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={tab.faviconUrl} alt="" className="w-3.5 h-3.5 flex-shrink-0" />
                        ) : (
                          <Globe className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/80" />
                        )}
                        <span className="truncate">{tab.title || (tab.url ? new URL(tab.url).hostname : 'New tab')}</span>
                        {rbTabs.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void closeRbTab(tab.id); }}
                            className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 transition"
                            title="Close tab"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <iframe
                  src={rbActiveTabId ? (rbTabs.find(t => t.id === rbActiveTabId)?.debuggerFullscreenUrl || rbLiveUrl) : rbLiveUrl}
                  className={`w-full rounded-lg border bg-muted/40 ${rbFullscreen ? 'flex-1 min-h-0' : 'h-[85vh]'}`}
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"
                  allow="clipboard-read; clipboard-write; autoplay; microphone; camera"
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground py-2">Browser session active — click <strong>Show</strong> to reveal.</p>
            )}
          </div>

          <div className="bg-card rounded-xl shadow-sm border p-6">
            <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
              <Lock className="w-5 h-5" />
              Password Vault
            </h3>

            {activeCall && customer ? (
              <div className="space-y-3">
                {credentials.length === 0 && !showAddCredential ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No saved credentials for this customer.
                  </p>
                ) : (
                  credentials.map((cred) => (
                    <div
                      key={cred.id}
                      className="flex items-center justify-between p-3 bg-muted/40 rounded-lg border"
                    >
                      <div>
                        <div className="font-medium text-sm">{cred.service_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {cred.username || 'No username'}
                        </div>
                      </div>
                      <button
                        onClick={() => copyPassword(cred.id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded-lg text-xs font-medium hover:bg-accent/90 transition"
                        title="Copy password to clipboard"
                      >
                        {copiedId === cred.id ? (
                          <>
                            <CheckCircle className="w-3 h-3" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                  ))
                )}

                {/* Add Credential Form */}
                {showAddCredential ? (
                  <div className="p-3 bg-accent/10 rounded-lg border border-accent/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-accent">New Credential</span>
                      <button onClick={() => setShowAddCredential(false)} className="text-muted-foreground/80 hover:text-muted-foreground">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <input
                      placeholder="Service name (e.g. Amazon)"
                      value={newCred.serviceName}
                      onChange={(e) => setNewCred((p) => ({ ...p, serviceName: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      placeholder="Username / email (optional)"
                      value={newCred.username}
                      onChange={(e) => setNewCred((p) => ({ ...p, username: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={newCred.password}
                      onChange={(e) => setNewCred((p) => ({ ...p, password: e.target.value }))}
                      className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={addCredential}
                      className="w-full bg-accent text-white rounded py-1.5 text-sm font-medium hover:bg-accent/90 transition"
                    >
                      Save to Vault
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAddCredential(true)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground hover:border-accent/50 hover:text-accent transition"
                  >
                    <Plus className="w-4 h-4" />
                    Add Credential
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                {activeCall
                  ? 'No customer identified for this call.'
                  : 'Vault access is only available during an active call.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
