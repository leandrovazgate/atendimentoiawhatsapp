/** Utilidades: telefone, horário comercial. */

/**
 * Normaliza um telefone brasileiro para comparação: DDD + 8 últimos dígitos.
 * Resolve a diferença do "9" extra (o wa_id da Meta às vezes vem sem ele).
 */
export function phoneKey(phone: string): string | undefined {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  digits = digits.replace(/^0+/, "");
  if (digits.length < 10) return undefined;
  return digits.slice(0, 2) + digits.slice(-8);
}

export function samePhone(a: string, b: string): boolean {
  const ka = phoneKey(a);
  return ka !== undefined && ka === phoneKey(b);
}

const DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

/**
 * Interpreta BUSINESS_HOURS no formato "seg-sex 08:00-18:00" (vários blocos separados por ";",
 * ex.: "seg-sex 08:00-18:00; sab 08:00-12:00").
 */
export function isBusinessHours(spec: string, timezone: string, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
  const dayIdx = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(wd.slice(0, 3));
  const hh = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  const minutes = hh * 60 + mm;

  for (const block of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = block.match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i);
    if (!m) continue;
    const start = DAYS.indexOf(m[1].toLowerCase());
    const end = m[2] ? DAYS.indexOf(m[2].toLowerCase()) : start;
    if (start < 0 || end < 0) continue;
    const inDay = start <= end ? dayIdx >= start && dayIdx <= end : dayIdx >= start || dayIdx <= end;
    const from = Number(m[3]) * 60 + Number(m[4]);
    const to = Number(m[5]) * 60 + Number(m[6]);
    if (inDay && minutes >= from && minutes < to) return true;
  }
  return false;
}

export function formatNow(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}
