import { describe, expect, it } from "vitest";
import { currentMonthViewDate, dateKey, miniMonthDates, parseCalendarRoute, routePath, shiftView, visibleDates } from "./calendar-view";

const keys = (dates: Date[]) => dates.map(dateKey);

describe("calendar view routes", () => {
  it("accepts the existing month route and deep links to week and day views", () => {
    expect(parseCalendarRoute("2026-10").view).toBe("month");
    expect(routePath("week", new Date(2026, 9, 6))).toBe("week/2026-10-06");
    expect(parseCalendarRoute("day/2026-10-06")).toMatchObject({ view: "day" });
    expect(dateKey(parseCalendarRoute("day/2026-10-06").date)).toBe("2026-10-06");
  });

  it("shows the correct days across week and three-day month boundaries", () => {
    expect(keys(visibleDates("week", new Date(2026, 9, 1)))).toEqual([
      "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30",
      "2026-10-01", "2026-10-02", "2026-10-03",
    ]);
    expect(keys(visibleDates("three", new Date(2026, 9, 31)))).toEqual([
      "2026-10-31", "2026-11-01", "2026-11-02",
    ]);
  });

  it("steps by the selected view and rejects invalid calendar dates", () => {
    expect(dateKey(shiftView("day", new Date(2026, 9, 31), 1))).toBe("2026-11-01");
    expect(dateKey(shiftView("three", new Date(2026, 9, 31), 1))).toBe("2026-11-03");
    expect(dateKey(shiftView("week", new Date(2026, 9, 31), 1))).toBe("2026-11-07");
    expect(dateKey(parseCalendarRoute("day/2026-02-30", new Date(2026, 8, 23)).date)).toBe("2026-10-01");
  });

  it("starts the current month window with this week, even when most days are next month", () => {
    const today = new Date(2026, 8, 23);
    const month = currentMonthViewDate(today);
    expect(dateKey(month)).toBe("2026-10-01");
    expect(dateKey(parseCalendarRoute("", today).date)).toBe("2026-10-01");
    const dates = visibleDates("month", month, today);
    expect(dates).toHaveLength(42);
    expect(keys(dates.slice(0, 7))).toEqual([
      "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
      "2026-09-24", "2026-09-25", "2026-09-26",
    ]);
    expect(dateKey(dates[41])).toBe("2026-10-31");
    expect(dateKey(miniMonthDates(month)[0])).toBe("2026-09-27");
  });

  it("keeps other browsed months aligned to their first week", () => {
    const today = new Date(2026, 8, 23);
    expect(dateKey(visibleDates("month", new Date(2026, 10, 1), today)[0])).toBe("2026-11-01");
  });
});
