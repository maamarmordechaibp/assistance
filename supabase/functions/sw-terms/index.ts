// Edge Function: sw-terms (reads terms & conditions, then returns to main menu)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId');

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  // Fetch terms from admin settings
  const { data: setting } = await supabase
    .from('admin_settings')
    .select('value')
    .eq('key', 'terms_and_conditions')
    .single();

  const termsText = (setting?.value as string) || 'No terms and conditions are currently available.';

  const elements: string[] = [];
  elements.push(laml.say('Here are our terms and conditions.'));
  elements.push(laml.pause(1));
  elements.push(laml.say(termsText));
  elements.push(laml.pause(2));

  // Return to main menu
  if (customerId) {
    elements.push(laml.say('Returning to the main menu.'));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
  } else {
    elements.push(laml.say('Thank you for calling. Goodbye.'));
    elements.push(laml.hangup());
  }

  return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
});
