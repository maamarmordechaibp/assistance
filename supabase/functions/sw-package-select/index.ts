// Edge Function: sw-package-select (IVR package menu for phone-based purchase)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const digits = formData.get('Digits') as string;
  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId') || '';
  const step = url.searchParams.get('step') || 'choice';

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;
  const supabase = createServiceClient();
  const elements: string[] = [];

  // ── One-tap refill: caller chose 2>3# in the IVR ──
  // We jump straight to the "press 1 to confirm" step for the supplied
  // package id, skipping the listing.
  const autoSelect = url.searchParams.get('autoSelect');
  if (autoSelect && step === 'choice' && !digits) {
    const { data: pkg } = await supabase
      .from('payment_packages')
      .select('id, name, minutes, price, is_active')
      .eq('id', autoSelect)
      .eq('is_active', true)
      .maybeSingle();
    if (pkg) {
      elements.push(
        laml.gather(
          {
            input: 'dtmf',
            numDigits: 1,
            action: `${baseUrl}/sw-package-select?step=proceed&customerId=${customerId}&packageId=${pkg.id}`,
            timeout: 10,
          },
          [laml.say(`Refilling the ${pkg.name} package: ${pkg.minutes} minutes for ${pkg.price} dollars. Press 1 to confirm and enter your credit card, or press 2 to choose a different package.`)]
        )
      );
      const xmlR = laml.buildLamlResponse(elements);
      return new Response(xmlR, { headers: { 'Content-Type': 'application/xml' } });
    }
  }

  if (step === 'choice') {
    // First entry to the package menu: list packages and let the caller
    // pick a number, or 0 to skip to a rep. (Old behavior: !digits skipped
    // straight to queue, which broke 2>2 in the new IVR tree.)
    if (digits === '0') {
      elements.push(laml.say('Connecting you to a representative now.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    } else {
      // Read packages aloud
      const { data: packages } = await supabase
        .from('payment_packages')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');

      if (!packages || packages.length === 0) {
        elements.push(laml.say('No packages are currently available. Connecting you to a representative.'));
        elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
      } else {
        const announcements: string[] = [];
        packages.forEach((pkg: { name: string; minutes: number; price: number; description?: string | null }, i: number) => {
          const num = i + 1;
          // NOTE: We intentionally DO NOT speak `pkg.description` here.
          // Descriptions historically contained hard-coded prices that drift
          // out of sync with `pkg.price`. The live `${pkg.minutes}` and
          // `${pkg.price}` are always authoritative, so we read those only.
          const main = `Press ${num} for the ${pkg.name} package: ${pkg.minutes} minutes for ${pkg.price} dollars.`;
          announcements.push(laml.say(main));
          announcements.push(laml.pause(1));
        });

        elements.push(
          laml.gather(
            {
              input: 'dtmf',
              numDigits: 1,
              action: `${baseUrl}/sw-package-select?step=confirm&customerId=${customerId}`,
              timeout: 15,
            },
            [
              laml.say('Here are our available minute packages.'),
              ...announcements,
              laml.say(`Press 0 to skip and speak with a representative.`),
            ]
          )
        );
      }
    }
  } else if (step === 'confirm') {
    // Caller selected a package number
    if (digits === '0' || !digits) {
      elements.push(laml.say('Connecting you to a representative now.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    } else {
      const pkgIndex = parseInt(digits, 10) - 1;
      const { data: packages } = await supabase
        .from('payment_packages')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');

      if (!packages || pkgIndex < 0 || pkgIndex >= packages.length) {
        elements.push(laml.say('Invalid selection. Connecting you to a representative.'));
        elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
      } else {
        const pkg = packages[pkgIndex];
        elements.push(
          laml.gather(
            {
              input: 'dtmf',
              numDigits: 1,
              action: `${baseUrl}/sw-package-select?step=proceed&customerId=${customerId}&packageId=${pkg.id}`,
              timeout: 10,
            },
            [laml.say(`You selected the ${pkg.name} package. ${pkg.minutes} minutes for $${pkg.price}. Press 1 to confirm and enter your credit card, or press 2 to go back.`)]
          )
        );
      }
    }
  } else if (step === 'proceed') {
    const packageId = url.searchParams.get('packageId') || '';
    if (digits === '1') {
      // Redirect to card gathering flow
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?step=card&customerId=${customerId}&packageId=${packageId}`));
    } else {
      // Go back to package menu
      elements.push(laml.redirect(`${baseUrl}/sw-package-select?step=choice&customerId=${customerId}`));
    }
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});
