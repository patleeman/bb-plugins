import { describe, expect, it } from "vitest";
import { projectOccurrences, type CalendarItem } from "./server";

const stamp = (value: string) => new Date(value).getTime();
const item = (trigger: CalendarItem["automation"]["trigger"], createdAt: number): CalendarItem => ({
  project: { id: "proj_test", name: "Test" },
  automation: {
    id: "auto_test",
    projectId: "proj_test",
    name: "Test",
    enabled: true,
    trigger,
    execution: { mode: "script" },
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt,
  },
});

describe("calendar projections", () => {
  it("keeps a 9am New York cron schedule at local 9am across daylight saving time", () => {
    const occurrences = projectOccurrences(
      [item({ triggerType: "schedule", cron: "0 9 * * *", timezone: "America/New_York" }, stamp("2026-03-01T00:00:00Z"))],
      stamp("2026-03-07T00:00:00Z"),
      stamp("2026-03-10T00:00:00Z"),
    );
    expect(occurrences.map((entry) => entry.at)).toEqual([
      stamp("2026-03-07T14:00:00Z"),
      stamp("2026-03-08T13:00:00Z"),
      stamp("2026-03-09T13:00:00Z"),
    ]);
  });

  it("does not project recurring dates before an automation was created", () => {
    const occurrences = projectOccurrences(
      [item({ triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" }, stamp("2026-10-03T12:00:00Z"))],
      stamp("2026-10-01T00:00:00Z"),
      stamp("2026-10-06T00:00:00Z"),
    );
    expect(occurrences.map((entry) => entry.at)).toEqual([
      stamp("2026-10-04T09:00:00Z"),
      stamp("2026-10-05T09:00:00Z"),
    ]);
  });

  it("projects a weekly schedule across the full month grid", () => {
    const occurrences = projectOccurrences(
      [item({ triggerType: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" }, stamp("2026-09-24T01:47:25Z"))],
      stamp("2026-09-27T04:00:00Z"),
      stamp("2026-11-01T04:00:00Z"),
    );
    expect(occurrences.map((entry) => new Date(entry.at).toISOString())).toContain("2026-10-05T13:00:00.000Z");
  });

  it("includes a one-time task once and rejects ranges over 45 days", () => {
    const once = item({ triggerType: "once", runAt: stamp("2026-10-14T14:00:00Z") }, stamp("2026-09-01T00:00:00Z"));
    expect(projectOccurrences([once], stamp("2026-10-01T00:00:00Z"), stamp("2026-11-01T00:00:00Z"))).toHaveLength(1);
    expect(() => projectOccurrences([once], stamp("2026-10-01T00:00:00Z"), stamp("2026-12-01T00:00:00Z"))).toThrow(/45 days/);
  });
});
