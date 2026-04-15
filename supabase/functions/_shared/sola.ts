// Sola Payments (Cardknox) API (Deno-compatible)

const SOLA_API_URL = 'https://x1.cardknox.com/gateway';

interface SolaResponse {
  xResult: 'A' | 'D' | 'E';
  xStatus: string;
  xError: string;
  xRefNum: string;
  xToken: string;
  xAuthCode: string;
  xAuthAmount: string;
  xMaskedCardNumber: string;
  xCardType: string;
  [key: string]: string;
}

function getSolaKey(): string {
  return Deno.env.get('SOLA_XKEY') || Deno.env.get('SOLA_SANDBOX_XKEY') || '';
}

async function solaRequest(params: Record<string, string | undefined>): Promise<SolaResponse> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, value);
  }
  const res = await fetch(SOLA_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  const result: Record<string, string> = {};
  for (const pair of text.split('&')) {
    const [key, val] = pair.split('=');
    result[decodeURIComponent(key)] = decodeURIComponent(val || '');
  }
  return result as unknown as SolaResponse;
}

export async function processCreditCardSale(params: {
  amount: number; cardNumber: string; expiration: string; cvv: string;
  invoice?: string; customerName?: string; customerEmail?: string;
}): Promise<SolaResponse> {
  return solaRequest({
    xKey: getSolaKey(), xVersion: '5.0.0', xSoftwareName: 'AssistancePlatform', xSoftwareVersion: '1.0.0',
    xCommand: 'cc:sale', xAmount: params.amount.toFixed(2),
    xCardNum: params.cardNumber, xExp: params.expiration, xCVV: params.cvv,
    xInvoice: params.invoice, xName: params.customerName, xEmail: params.customerEmail,
  });
}

export async function processTokenSale(params: {
  amount: number; token: string; invoice?: string; customerName?: string;
}): Promise<SolaResponse> {
  return solaRequest({
    xKey: getSolaKey(), xVersion: '5.0.0', xSoftwareName: 'AssistancePlatform', xSoftwareVersion: '1.0.0',
    xCommand: 'cc:sale', xAmount: params.amount.toFixed(2), xToken: params.token, xInvoice: params.invoice,
    xName: params.customerName,
  });
}

export async function voidTransaction(refNum: string): Promise<SolaResponse> {
  return solaRequest({
    xKey: getSolaKey(), xVersion: '5.0.0', xSoftwareName: 'AssistancePlatform', xSoftwareVersion: '1.0.0',
    xCommand: 'cc:void', xRefNum: refNum,
  });
}

export async function refundTransaction(refNum: string, amount?: number): Promise<SolaResponse> {
  return solaRequest({
    xKey: getSolaKey(), xVersion: '5.0.0', xSoftwareName: 'AssistancePlatform', xSoftwareVersion: '1.0.0',
    xCommand: 'cc:refund', xRefNum: refNum, xAmount: amount ? amount.toFixed(2) : undefined,
  });
}
