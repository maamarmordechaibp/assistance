// OTP detection logic (shared by email-inbound and sw-sms-inbound)
export function detectOtp(text: string): string | null {
  if (!text) return null;
  // (A1) Labelled digits: "OTP: 123456", "code is 1234", etc.
  const labelDigits = /(?:otp|code|pass(?:word)?|verify|verification|auth(?:entication)?|pin)[^\d]{0,10}(\d{4,10})/i;
  const m1 = text.match(labelDigits);
  if (m1) return m1[1];
  // (A2) Labelled alphanumeric (uppercase, must contain digit)
  const labelAlpha = /(?:otp|code|pass(?:word)?|verify|verification|auth(?:entication)?|pin)[^A-Z0-9]{0,10}([A-Z0-9]{4,10})/;
  const m2 = text.match(labelAlpha);
  if (m2 && /\d/.test(m2[1])) return m2[1];
  // (B) Standalone digit run on its own line
  const lineDigits = /^\s*(\d{4,10})\s*$/m;
  const m3 = text.match(lineDigits);
  if (m3) return m3[1];
  // (C) Digit run in subject (not used for SMS, but harmless)
  const subjDigits = /subject:.*?(\d{4,10})/i;
  const m4 = text.match(subjDigits);
  if (m4) return m4[1];
  return null;
}
