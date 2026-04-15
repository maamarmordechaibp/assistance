// Minute balance calculation utilities

export function roundUpMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

export function calculateBillableMinutes(
  connectedAt: string | Date,
  endedAt: string | Date
): number {
  const start = new Date(connectedAt).getTime();
  const end = new Date(endedAt).getTime();
  const durationSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return roundUpMinutes(durationSeconds);
}

export function formatMinuteAnnouncement(
  minutes: number,
  template: string = 'You currently have {minutes} minutes remaining.'
): string {
  const rounded = Math.round(minutes);
  return template.replace('{minutes}', rounded.toString());
}

export function canProceedWithBalance(
  currentBalance: number,
  negativeBalanceEnabled: boolean,
  maxNegativeBalance: number
): boolean {
  if (currentBalance > 0) return true;
  if (!negativeBalanceEnabled) return false;
  return currentBalance > maxNegativeBalance;
}
