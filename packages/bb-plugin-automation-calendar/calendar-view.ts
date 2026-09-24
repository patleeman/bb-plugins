export type CalendarView = "day" | "three" | "week" | "month";
export type CalendarRoute = { view: CalendarView; date: Date };

export function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export const monthKey = (date: Date) => dateKey(date).slice(0, 7);
export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
export const addDays = (date: Date, count: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
export const weekStart = (date: Date) => addDays(date, -date.getDay());
export const currentMonthViewDate = (today: Date) => monthStart(addDays(weekStart(today), 21));

export function addMonths(date: Date, count: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + count, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1970 || year > 2100) return null;
  const parsed = new Date(year, month - 1, day);
  return dateKey(parsed) === value ? parsed : null;
}

export function parseCalendarRoute(subPath: string, today = new Date()): CalendarRoute {
  const month = /^(?:month\/)?(\d{4})-(\d{2})$/.exec(subPath);
  if (month) {
    const parsed = parseDate(`${month[1]}-${month[2]}-01`);
    if (parsed) return { view: "month", date: parsed };
  }
  const match = /^(day|three|week)\/(\d{4}-\d{2}-\d{2})$/.exec(subPath);
  if (match) {
    const parsed = parseDate(match[2]);
    if (parsed) return { view: match[1] as CalendarView, date: parsed };
  }
  return { view: "month", date: currentMonthViewDate(today) };
}

export function routePath(view: CalendarView, date: Date): string {
  return view === "month" ? monthKey(date) : `${view}/${dateKey(date)}`;
}

export function miniMonthDates(date: Date): Date[] {
  const first = monthStart(date);
  const start = weekStart(first);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const end = addDays(last, 6 - last.getDay());
  const result: Date[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) result.push(cursor);
  return result;
}

export function visibleDates(view: CalendarView, date: Date, today = new Date()): Date[] {
  if (view === "day") return [new Date(date.getFullYear(), date.getMonth(), date.getDate())];
  if (view === "three") return Array.from({ length: 3 }, (_, index) => addDays(date, index));
  if (view === "week") {
    const sunday = weekStart(date);
    return Array.from({ length: 7 }, (_, index) => addDays(sunday, index));
  }
  const start = weekStart(monthKey(date) === monthKey(currentMonthViewDate(today)) ? today : monthStart(date));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function shiftView(view: CalendarView, date: Date, direction: -1 | 1): Date {
  if (view === "month") return monthStart(addMonths(date, direction));
  return addDays(date, direction * (view === "week" ? 7 : view === "three" ? 3 : 1));
}
