/** Whole minutes between two ISO timestamps. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
}
