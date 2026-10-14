const pad = (value: number) => String(value).padStart(2, "0");

/** Formats an ISO timestamp for <input type="datetime-local">, which wants local time without a zone. */
export function toDateTimeLocal(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Turns a datetime-local value (local time) into an ISO timestamp, or null when it is empty or invalid. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
