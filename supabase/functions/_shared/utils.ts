// Utility functions (Deno-compatible)

export function roundUpMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

export function calculateBillableMinutes(connectedAt: string | Date, endedAt: string | Date): number {
  const start = new Date(connectedAt).getTime();
  const end = new Date(endedAt).getTime();
  const durationSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return roundUpMinutes(durationSeconds);
}

export function formatMinuteAnnouncement(minutes: number, template = 'You currently have {minutes} minutes remaining.'): string {
  return template.replace('{minutes}', Math.round(minutes).toString());
}
