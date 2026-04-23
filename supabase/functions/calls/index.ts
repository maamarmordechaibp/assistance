// Edge Function: calls (GET list, PATCH update)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createUserClient(req);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const customerId = url.searchParams.get('customerId');
    const repId = url.searchParams.get('repId');
    const flagStatus = url.searchParams.get('flagStatus');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '25', 10);
    const offset = (page - 1) * limit;

    let query = supabase
      .from('calls')
      .select(`*, customer:customers(id, full_name, primary_phone), rep:reps(id, full_name), task_category:task_categories(id, name), analysis:call_analyses(*)`, { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (customerId) query = query.eq('customer_id', customerId);
    if (repId) query = query.eq('rep_id', repId);
    if (flagStatus) query = query.eq('flag_status', flagStatus);

    const { data, count, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ calls: data, total: count, page, limit }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const dbUpdates: Record<string, unknown> = {};
    if (updates.repNotes !== undefined) dbUpdates.rep_notes = updates.repNotes;
    if (updates.taskCategoryId !== undefined) dbUpdates.task_category_id = updates.taskCategoryId;
    if (updates.outcomeStatus !== undefined) dbUpdates.outcome_status = updates.outcomeStatus;
    if (updates.followupNeeded !== undefined) dbUpdates.followup_needed = updates.followupNeeded;
    if (updates.flagStatus !== undefined) dbUpdates.flag_status = updates.flagStatus;
    if (updates.flagReason !== undefined) dbUpdates.flag_reason = updates.flagReason;

    // ── If this is a call-ended PATCH, stamp ended_at + duration and kick
    //    off ai-analyze asynchronously. We detect "ending" heuristically as
    //    any PATCH that includes outcomeStatus OR an explicit endCall:true. ──
    const isEndingCall = !!updates.endCall || updates.outcomeStatus !== undefined;

    if (isEndingCall) {
      // Use service client to read connected_at + to stamp end-time fields
      // (rep RLS may restrict some of these columns).
      const service = createServiceClient();
      const { data: existing } = await service.from('calls').select('connected_at, started_at, ended_at').eq('id', id).maybeSingle();
      if (existing && !existing.ended_at) {
        const endedAt = new Date();
        dbUpdates.ended_at = endedAt.toISOString();
        const startMs = existing.connected_at
          ? new Date(existing.connected_at).getTime()
          : existing.started_at
            ? new Date(existing.started_at).getTime()
            : endedAt.getTime();
        const secs = Math.max(0, Math.round((endedAt.getTime() - startMs) / 1000));
        dbUpdates.total_duration_seconds = secs;
      }
    }

    const { data, error } = await supabase.from('calls').update(dbUpdates).eq('id', id).select().single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // ── Post-call: synthesise a transcript from rep notes + AI brief +
    //    findings, then fire-and-forget ai-analyze so the call history gets
    //    a report even without real audio transcription. Also auto-close the
    //    customer's Browserbase session so we stop being billed. ──
    if (isEndingCall) {
      try {
        const service = createServiceClient();

        // Auto-close the active Browserbase session for this customer
        try {
          const customerId = (data as { customer_id?: string })?.customer_id;
          if (customerId) {
            const { data: active } = await service.from('customer_browser_sessions')
              .select('id, bb_session_id')
              .eq('customer_id', customerId).eq('status', 'active');
            for (const row of active || []) {
              try {
                await fetch(`https://api.browserbase.com/v1/sessions/${row.bb_session_id}`, {
                  method: 'POST',
                  headers: {
                    'X-BB-API-Key': Deno.env.get('BROWSERBASE_API_KEY') || '',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ projectId: Deno.env.get('BROWSERBASE_PROJECT_ID'), status: 'REQUEST_RELEASE' }),
                });
              } catch { /* still mark ended below */ }
              await service.from('customer_browser_sessions')
                .update({ status: 'ended', ended_at: new Date().toISOString() })
                .eq('id', row.id);
            }
          }
        } catch (e) { console.error('[calls] bb auto-close failed:', e); }

        const { data: full } = await service.from('calls')
          .select('id, rep_notes, ai_intake_brief, customer_id, transcript_text')
          .eq('id', id)
          .maybeSingle();
        if (full) {
          let transcript = full.transcript_text || '';
          if (!transcript) {
            const parts: string[] = [];
            const brief = full.ai_intake_brief as Record<string, unknown> | null;
            if (brief) {
              const summary = brief.summary as string | undefined;
              const category = brief.category as string | undefined;
              if (summary) parts.push(`AI INTAKE SUMMARY (category=${category || 'other'}): ${summary}`);
              const sug = brief.suggestions as Record<string, unknown> | undefined;
              if (sug) {
                if (Array.isArray(sug.search_terms) && sug.search_terms.length) parts.push(`Intake search terms: ${(sug.search_terms as string[]).join(', ')}`);
                if (typeof sug.rep_tip === 'string') parts.push(`Intake rep tip: ${sug.rep_tip}`);
              }
            }
            if (full.rep_notes) parts.push(`REPRESENTATIVE NOTES:\n${full.rep_notes}`);
            const { data: findings } = await service.from('call_findings')
              .select('description, item_url, item_price, item_platform, item_notes')
              .eq('call_id', id);
            if (findings && findings.length) {
              parts.push('FINDINGS LOGGED BY REP:');
              for (const f of findings) {
                parts.push(`- ${f.description}${f.item_price ? ` (${f.item_price})` : ''}${f.item_platform ? ` on ${f.item_platform}` : ''}${f.item_url ? ` — ${f.item_url}` : ''}${f.item_notes ? ` — ${f.item_notes}` : ''}`);
              }
            }
            transcript = parts.join('\n\n');
          }

          if (transcript.trim().length > 0) {
            // Persist the synthesised transcript so ai-analyze sees it.
            await service.from('calls').update({ transcript_text: transcript }).eq('id', id);

            // Fire-and-forget ai-analyze. Don't await — response to rep should be instant.
            const fnUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-analyze`;
            fetch(fnUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({ callId: id }),
            }).catch(err => console.error('[calls] ai-analyze kickoff failed:', err));
          }
        }
      } catch (err) {
        console.error('[calls] post-call processing error:', err);
      }
    }

    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
