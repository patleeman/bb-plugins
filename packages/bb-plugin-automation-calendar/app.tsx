import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { CalendarItem, CalendarOccurrence, rpcContract } from "./server";
import {
  addDays, addMonths, currentMonthViewDate, dateKey, miniMonthDates, parseCalendarRoute,
  routePath, shiftView, visibleDates, weekStart, type CalendarView,
} from "./calendar-view";
import "./calendar.css";

type CalendarData = { items: CalendarItem[]; occurrences: CalendarOccurrence[] };
type CalendarEvent = { item: CalendarItem; occurrence: CalendarOccurrence };
type Position = { left: number; top: number };
type Popup =
  | { kind: "event"; event: CalendarEvent; position: Position }
  | { kind: "list"; events: CalendarEvent[]; title: string; position: Position };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const VIEWS: { id: CalendarView; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "three", label: "3 days" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];
const formatMonth = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
const formatDay = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
const formatTime = (at: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
const formatHour = (hour: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2026, 0, 1, hour));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const itemKey = (item: CalendarItem) => item.automation.projectId + "/" + item.automation.id;
const eventKey = (event: CalendarEvent) => itemKey(event.item) + "/" + event.occurrence.at;

function periodTitle(view: CalendarView, dates: Date[]): string {
  if (view === "month") return formatMonth(dates[Math.floor(dates.length / 2)]);
  if (view === "day") return formatDay(dates[0]);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).formatRange(dates[0], dates[dates.length - 1]);
}

function popupPosition(rect: DOMRect): Position {
  const width = Math.min(360, window.innerWidth - 24);
  let left = rect.right + 12;
  if (left + width > window.innerWidth - 12) left = rect.left - width - 12;
  if (left < 12) left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(rect.top - 12, window.innerHeight - 472));
  return { left, top };
}

function TimeView({
  view, dates, eventsByDay, today, onOpenEvent, onOpenList, onChooseDay, scrollRef,
}: {
  view: Exclude<CalendarView, "month">;
  dates: Date[];
  eventsByDay: Map<string, CalendarEvent[]>;
  today: string;
  onOpenEvent: (event: CalendarEvent, click: MouseEvent<HTMLElement>) => void;
  onOpenList: (events: CalendarEvent[], title: string, click: MouseEvent<HTMLElement>) => void;
  onChooseDay: (date: Date) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const columns = { gridTemplateColumns: "58px repeat(" + dates.length + ", minmax(0, 1fr))" };
  return (
    <div className="ac-time-view" data-view={view} aria-label={periodTitle(view, dates) + " automation calendar"}>
      <div className="ac-time-header" style={columns}>
        <span className="ac-time-corner" />
        {dates.map((day) => (
          <button key={dateKey(day)} className={dateKey(day) === today ? "ac-time-heading ac-time-heading-today" : "ac-time-heading"} onClick={() => onChooseDay(day)}>
            <span>{WEEKDAYS[day.getDay()]}</span><strong>{day.getDate()}</strong>
          </button>
        ))}
      </div>
      <div className="ac-time-scroll" ref={scrollRef}>
        <div className="ac-time-rows" style={columns}>
          {HOURS.flatMap((hour) => [
            <div className="ac-hour-label" key={"label-" + hour}>{formatHour(hour)}</div>,
            ...dates.map((day) => {
              const key = dateKey(day);
              const events = (eventsByDay.get(key) ?? []).filter((event) => new Date(event.occurrence.at).getHours() === hour);
              return (
                <div className={key === today ? "ac-time-slot ac-time-slot-today" : "ac-time-slot"} key={key + "-" + hour}>
                  {events.slice(0, 2).map((event) => (
                    <button className={event.item.automation.enabled ? "ac-time-event" : "ac-time-event ac-event-paused"} key={eventKey(event)} onClick={(click) => onOpenEvent(event, click)} title={event.item.automation.name + " · " + formatTime(event.occurrence.at)}>
                      <time>{formatTime(event.occurrence.at)}</time><span>{event.item.automation.name}</span>
                    </button>
                  ))}
                  {events.length > 2 ? <button className="ac-time-more" onClick={(click) => onOpenList(events, formatHour(hour) + " · " + formatDay(day), click)}>+{events.length - 2} more</button> : null}
                </div>
              );
            }),
          ])}
        </div>
      </div>
    </div>
  );
}

function EventPopup({
  popup, currentItem, pending, onClose, onSelectEvent, onAction, popupRef,
}: {
  popup: Popup;
  currentItem: CalendarItem | null;
  pending: boolean;
  onClose: () => void;
  onSelectEvent: (event: CalendarEvent) => void;
  onAction: (action: "pause" | "resume" | "run", item: CalendarItem) => void;
  popupRef: RefObject<HTMLElement | null>;
}) {
  return (
    <section className="ac-popover" role="dialog" aria-modal="false" aria-label={popup.kind === "list" ? popup.title : currentItem?.automation.name ?? "Automation"} ref={popupRef} tabIndex={-1} style={popup.position}>
      <div className="ac-popover-header">
        <span>{popup.kind === "list" ? "Scheduled" : currentItem?.project.id === "proj_personal" ? "Local" : currentItem?.project.name}</span>
        <button className="ac-icon-button" aria-label="Close details" onClick={onClose}>×</button>
      </div>
      {popup.kind === "list" ? (
        <>
          <h2>{popup.title}</h2>
          <div className="ac-popover-list">
            {popup.events.map((event) => (
              <button key={eventKey(event)} onClick={() => onSelectEvent(event)}>
                <strong>{event.item.automation.name}</strong><time>{formatTime(event.occurrence.at)}</time>
              </button>
            ))}
          </div>
        </>
      ) : currentItem ? (
        <>
          <h2>{currentItem.automation.name}</h2>
          <div className="ac-popover-meta">
            <span>{currentItem.automation.execution.mode === "agent" ? "Agent" : "Script"}</span>
            <span>{currentItem.automation.enabled ? "Active" : "Paused"}</span>
          </div>
          <dl>
            <div><dt>Scheduled</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(popup.event.occurrence.at)}</dd></div>
            <div><dt>Schedule</dt><dd>{currentItem.automation.trigger.triggerType === "once" ? "One time" : currentItem.automation.trigger.cron + " · " + currentItem.automation.trigger.timezone}</dd></div>
            {currentItem.automation.lastRunStatus ? <div><dt>Last run</dt><dd>{currentItem.automation.lastRunStatus}</dd></div> : null}
          </dl>
          <div className="ac-popover-actions">
            <a className="ac-button ac-primary" href={"/plugins/automations/automations/" + encodeURIComponent(currentItem.automation.projectId) + "/" + encodeURIComponent(currentItem.automation.id) + (currentItem.automation.execution.mode === "agent" ? "/edit" : "")}>Open in Automations ↗</a>
            <button className="ac-button" disabled={pending} onClick={() => onAction(currentItem.automation.enabled ? "pause" : "resume", currentItem)}>{currentItem.automation.enabled ? "Pause" : "Resume"}</button>
            <button className="ac-button" disabled={pending} onClick={() => onAction("run", currentItem)}>Run now</button>
          </div>
          <p className="ac-popover-note">Scheduled time, not run history.</p>
        </>
      ) : null}
    </section>
  );
}

function CalendarPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const route = useMemo(() => parseCalendarRoute(subPath), [subPath]);
  const { view, date } = route;
  const today = dateKey(new Date());
  const dates = useMemo(() => visibleDates(view, date, new Date(today + "T12:00:00")), [view, date, today]);
  const miniDates = useMemo(() => miniMonthDates(date), [date]);
  const rangeStart = dates[0].getTime();
  const rangeEnd = addDays(dates[dates.length - 1], 1).getTime();
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visibleProjects, setVisibleProjects] = useState<string[] | null>(null);
  const [showPaused, setShowPaused] = useState(true);
  const [focusedDay, setFocusedDay] = useState(() => dateKey(new Date()));
  const [popup, setPopup] = useState<Popup | null>(null);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);
  const popupRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const timeScrollRef = useRef<HTMLDivElement | null>(null);
  const navigateView = (nextView: CalendarView, nextDate: Date) => navigate.toPluginPanel("calendar", { subPath: routePath(nextView, nextDate) });
  useEffect(() => {
    const now = new Date();
    setFocusedDay((current) => {
      if (view !== "month") return dateKey(date);
      if (dates.some((day) => dateKey(day) === current)) return current;
      return dates.some((day) => dateKey(day) === dateKey(now)) ? dateKey(now) : dateKey(date);
    });
    setPopup(null);
  }, [view, date, dates]);

  const load = useCallback(() => {
    const request = ++requestRef.current;
    rpc.call("calendar_month", { startAt: rangeStart, endAt: rangeEnd }).then(
      (result) => {
        if (request !== requestRef.current) return;
        setData(result);
        setError(null);
      },
      (cause) => {
        if (request !== requestRef.current) return;
        setError(errorText(cause));
      },
    );
  }, [rpc, rangeStart, rangeEnd]);
  useEffect(() => {
    setData(null);
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(load, 60_000);
    return () => {
      requestRef.current += 1;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of data?.items ?? []) map.set(item.project.id, item.project.id === "proj_personal" ? "Local" : item.project.name);
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const itemsById = useMemo(() => new Map((data?.items ?? []).map((item) => [itemKey(item), item])), [data]);
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const normalizedQuery = query.trim().toLowerCase();
    for (const occurrence of data?.occurrences ?? []) {
      const item = itemsById.get(occurrence.projectId + "/" + occurrence.automationId);
      if (!item) continue;
      if (visibleProjects && !visibleProjects.includes(item.project.id)) continue;
      if (!showPaused && !item.automation.enabled) continue;
      if (normalizedQuery && !(item.automation.name + " " + item.project.name).toLowerCase().includes(normalizedQuery)) continue;
      const key = dateKey(new Date(occurrence.at));
      const events = map.get(key);
      if (events) events.push({ item, occurrence });
      else map.set(key, [{ item, occurrence }]);
    }
    return map;
  }, [data, itemsById, visibleProjects, showPaused, query]);

  useEffect(() => {
    if (view === "month" || data === null || !timeScrollRef.current) return;
    const hours = dates.flatMap((day) => (eventsByDay.get(dateKey(day)) ?? []).map((event) => new Date(event.occurrence.at).getHours()));
    const firstHour = hours.length ? Math.max(0, Math.min(...hours) - 1) : 8;
    timeScrollRef.current.scrollTop = firstHour * 72;
  }, [view, rangeStart, data, dates, eventsByDay]);

  const closePopup = useCallback(() => {
    setPopup(null);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!popup) return;
    popupRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !openerRef.current?.contains(target)) setPopup(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closePopup(); };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      setPopup(null);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onScroll, { capture: true, passive: true });
    window.addEventListener("touchmove", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("touchmove", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [popup, closePopup]);

  const openEvent = (event: CalendarEvent, click: MouseEvent<HTMLElement>) => {
    openerRef.current = click.currentTarget;
    setFocusedDay(dateKey(new Date(event.occurrence.at)));
    setPopup({ kind: "event", event, position: popupPosition(click.currentTarget.getBoundingClientRect()) });
  };
  const openList = (events: CalendarEvent[], title: string, click: MouseEvent<HTMLElement>) => {
    openerRef.current = click.currentTarget;
    setPopup({ kind: "list", events, title, position: popupPosition(click.currentTarget.getBoundingClientRect()) });
  };
  const create = (day?: Date) => {
    const datePrompt = day ? " on " + formatDay(day) : "";
    navigate.toCompose({ focusPrompt: true, initialPrompt: "Create a new bb automation" + datePrompt + " to " });
  };
  const action = async (kind: "pause" | "resume" | "run", item: CalendarItem) => {
    setPending(true);
    try {
      await rpc.call("calendar_action", { projectId: item.automation.projectId, automationId: item.automation.id, action: kind });
      setPopup(null);
      load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const popupItem = popup?.kind === "event" ? itemsById.get(itemKey(popup.event.item)) ?? popup.event.item : null;

  return (
    <div className="ac-page">
      <header className="ac-header">
        <div className="ac-heading"><h1>Calendar</h1><span>Scheduled automations</span></div>
        <div className="ac-header-actions">
          <button className="ac-button ac-today" onClick={() => navigateView(view, view === "month" ? currentMonthViewDate(new Date()) : new Date())}>Today</button>
          <button className="ac-button ac-primary" onClick={() => create()}>＋ New automation</button>
        </div>
      </header>
      <div className="ac-layout">
        <aside className="ac-sidebar">
          <div className="ac-mini-heading"><strong>{formatMonth(date)}</strong><div>
            <button className="ac-icon-button" aria-label="Previous month" onClick={() => navigateView(view, addMonths(date, -1))}>‹</button>
            <button className="ac-icon-button" aria-label="Next month" onClick={() => navigateView(view, addMonths(date, 1))}>›</button>
          </div></div>
          <div className="ac-mini-calendar" aria-label={formatMonth(date)}>
            {WEEKDAYS.map((day) => <span className="ac-mini-weekday" key={day}>{day[0]}</span>)}
            {miniDates.map((day) => {
              const key = dateKey(day);
              const classes = ["ac-mini-day", day.getMonth() !== date.getMonth() && "ac-outside", key === today && "ac-mini-today", key === focusedDay && "ac-mini-selected"].filter(Boolean).join(" ");
              return <button key={key} className={classes} onClick={() => navigateView("day", day)} aria-label={"Show " + formatDay(day)}>{day.getDate()}{view === "month" && eventsByDay.has(key) ? <i /> : null}</button>;
            })}
          </div>
          <div className="ac-sidebar-section">
            <div className="ac-section-heading">Projects</div>
            {projects.length === 0 ? <p className="ac-muted">No scheduled projects</p> : projects.map(([id, name]) =>
              <label className="ac-project" key={id}><input type="checkbox" checked={visibleProjects === null || visibleProjects.includes(id)} onChange={() => setVisibleProjects((current) => {
                const selectedIds = current ?? projects.map(([projectId]) => projectId);
                return selectedIds.includes(id) ? selectedIds.filter((projectId) => projectId !== id) : [...selectedIds, id];
              })} /><span className="ac-project-dot" />{name}</label>,
            )}
            <label className="ac-project ac-paused-filter"><input type="checkbox" checked={showPaused} onChange={(event) => setShowPaused(event.target.checked)} />Show paused</label>
          </div>
        </aside>
        <main className="ac-main">
          <div className="ac-toolbar">
            <div className="ac-period-title"><h2>{periodTitle(view, dates)}</h2><span>Times shown in your local timezone</span></div>
            <div className="ac-toolbar-actions">
              <div className="ac-view-switch" role="group" aria-label="Calendar view">
                {VIEWS.map((option) => <button key={option.id} data-view={option.id} aria-pressed={view === option.id} className={view === option.id ? "ac-view-active" : ""} onClick={() => {
                  const focusedDate = new Date(focusedDay + "T12:00:00");
                  const monthDate = dateKey(weekStart(focusedDate)) === dateKey(weekStart(new Date())) ? currentMonthViewDate(new Date()) : focusedDate;
                  navigateView(option.id, option.id === "month" ? monthDate : focusedDate);
                }}>{option.label}</button>)}
              </div>
              <label className="ac-search"><span aria-hidden>⌕</span><input aria-label="Search automations" placeholder="Search automations" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              <button className="ac-icon-button" aria-label="Refresh calendar" onClick={load}>↻</button>
              <div className="ac-month-nav"><button aria-label="Previous period" onClick={() => navigateView(view, shiftView(view, date, -1))}>‹</button><button aria-label="Next period" onClick={() => navigateView(view, shiftView(view, date, 1))}>›</button></div>
            </div>
          </div>
          {error ? <div className="ac-error" role="alert">Couldn’t load calendar: {error}<button onClick={load}>Retry</button></div> : null}
          {view === "month" ? (
            <div className="ac-grid" data-view="month" aria-label={periodTitle(view, dates) + " automation calendar"}>
              {WEEKDAYS.map((day) => <div className="ac-weekday" key={day}>{day}</div>)}
              {dates.map((day) => {
                const key = dateKey(day);
                const events = eventsByDay.get(key) ?? [];
                const classes = ["ac-cell", day.getMonth() !== date.getMonth() && "ac-cell-outside", key === today && "ac-cell-today", key === focusedDay && "ac-cell-selected"].filter(Boolean).join(" ");
                return <div className={classes} key={key}>
                  <button className="ac-date" onClick={() => navigateView("day", day)} aria-label={"Show " + formatDay(day)}>{day.getDate()}</button>
                  <div className="ac-events">{events.slice(0, 3).map((event) =>
                    <button key={eventKey(event)} className={event.item.automation.enabled ? "ac-event" : "ac-event ac-event-paused"} title={event.item.automation.name + " · " + formatTime(event.occurrence.at)} onClick={(click) => openEvent(event, click)}>
                      <span className="ac-event-name">{event.item.automation.name}</span><time>{formatTime(event.occurrence.at)}</time>
                    </button>,
                  )}{events.length > 3 ? <button className="ac-more" onClick={(click) => openList(events, formatDay(day), click)}>+{events.length - 3} more</button> : null}</div>
                </div>;
              })}
            </div>
          ) : <TimeView view={view} dates={dates} eventsByDay={eventsByDay} today={today} onOpenEvent={openEvent} onOpenList={openList} onChooseDay={(day) => navigateView("day", day)} scrollRef={timeScrollRef} />}
          {data?.items.length === 0 ? <div className="ac-empty"><strong>No automations yet</strong><span>Create one to see its schedule here.</span><button className="ac-button ac-primary" onClick={() => create()}>New automation</button></div> : null}
        </main>
      </div>
      {popup ? <EventPopup popup={popup} currentItem={popupItem} pending={pending} onClose={closePopup} onSelectEvent={(event) => setPopup({ kind: "event", event, position: popup.position })} onAction={(kind, item) => void action(kind, item)} popupRef={popupRef} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "calendar",
    title: "Automations",
    icon: "Calendar",
    path: "calendar",
    component: CalendarPage,
  });
});
