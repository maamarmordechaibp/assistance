// Edge Function: packages (admin CRUD for payment packages)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);

  if (req.method === 'GET') {
    // Anyone authenticated can view active packages; admin sees all
    const isAdmin = user.app_metadata?.role === 'admin';
    const showAll = url.searchParams.get('all') === 'true' && isAdmin;

    let query = createServiceClient().from('payment_packages').select('*').order('sort_order');
    if (!showAll) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ packages: data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Admin-only below
  if (user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const service = createServiceClient();

  if (req.method === 'POST') {
    const body = await req.json();
    const { name, minutes, price, description } = body;
    if (!name || !minutes || !price) {
      return new Response(JSON.stringify({ error: 'name, minutes, price required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get next sort_order
    const { data: last } = await service.from('payment_packages').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
    const sortOrder = (last?.sort_order || 0) + 1;

    const { data, error } = await service.from('payment_packages').insert({
      name, minutes, price, description: description || '', sort_order: sortOrder, is_active: true,
    }).select().single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) {
      return new Response(JSON.stringify({ error: 'id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    updates.updated_at = new Date().toISOString();
    const { data, error } = await service.from('payment_packages').update(updates).eq('id', id).select().single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Soft delete — just deactivate
    const { error } = await service.from('payment_packages').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
});
