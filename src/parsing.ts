import { PolymarketEvent } from "./polymarket";

export function parseTempRange(
  question: string | undefined | null
): [number, number] | null {
  if (!question) return null;
  const q = question.toLowerCase();

  if (q.includes("or below")) {
    const m = /(\d+)°f or below/i.exec(question);
    if (m) return [-999, parseInt(m[1], 10)];
  }

  if (q.includes("or higher")) {
    const m = /(\d+)°f or higher/i.exec(question);
    if (m) return [parseInt(m[1], 10), 999];
  }

  const m = /between (\d+)-(\d+)°f/i.exec(question);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];

  return null;
}

export function hoursUntilResolution(event: PolymarketEvent): number {
  try {
    const endDate = (event as any).endDate ?? (event as any).end_date_iso;
    if (!endDate) return 999;
    const iso = String(endDate).replace("Z", "+00:00");
    const endDt = new Date(iso);
    const now = new Date();
    const deltaHours = (endDt.getTime() - now.getTime()) / (1000 * 3600);
    return Math.max(0, deltaHours);
  } catch {
    return 999;
  }
}

