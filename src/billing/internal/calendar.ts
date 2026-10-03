import { Temporal } from "@js-temporal/polyfill";
import type {
  CalendarPolicy,
  SubscriptionBoundaryRequest,
} from "../subscriptions-contract";

type Anchors = Pick<
  SubscriptionBoundaryRequest,
  "periodAnchorDate" | "dueAnchorDate" | "intervalMonths"
>;
export function localToday(now: Date, calendar: CalendarPolicy): string {
  return Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(calendar.timeZone)
    .toPlainDate()
    .toString();
}
export function validateCalendar(calendar: CalendarPolicy) {
  if (
    !Number.isInteger(calendar.issueHour) ||
    calendar.issueHour < 0 ||
    calendar.issueHour > 23 ||
    !Number.isInteger(calendar.chargeHour) ||
    calendar.chargeHour < 0 ||
    calendar.chargeHour > 23
  )
    throw new RangeError("Invalid calendar hours");
  localToday(new Date(), calendar);
}
function add(date: string, months: number): string {
  const result = Temporal.PlainDate.from(date).add(
    { months },
    { overflow: "constrain" },
  );
  if (result.year < 1 || result.year > 9999)
    throw new RangeError("Calendar boundary outside supported dates");
  return result.toString();
}
export function validateAnchors(anchors: Anchors) {
  if (
    ![1, 3, 6, 12, 24, 36].includes(anchors.intervalMonths) ||
    anchors.dueAnchorDate <
      add(anchors.periodAnchorDate, -anchors.intervalMonths) ||
    anchors.dueAnchorDate >
      add(anchors.periodAnchorDate, anchors.intervalMonths)
  )
    throw new RangeError("Unsupported due anchor");
}
export function periodBoundary(anchors: Anchors, periodIndex: number) {
  if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > 120000)
    throw new RangeError("Invalid period index");
  return {
    periodIndex,
    periodStart: add(
      anchors.periodAnchorDate,
      periodIndex * anchors.intervalMonths,
    ),
    periodEnd: add(
      anchors.periodAnchorDate,
      (periodIndex + 1) * anchors.intervalMonths,
    ),
    dueDate: add(anchors.dueAnchorDate, periodIndex * anchors.intervalMonths),
  };
}
export function nearIndex(
  anchor: string,
  interval: number,
  date: string,
): number {
  const a = Temporal.PlainDate.from(anchor),
    b = Temporal.PlainDate.from(date);
  return Math.max(
    0,
    Math.floor(((b.year - a.year) * 12 + b.month - a.month) / interval) - 1,
  );
}
export function indicesInWindow(
  anchors: Anchors,
  first: number,
  from: string,
  through: string,
): number[] {
  const indices: number[] = [];
  for (
    let i = Math.max(
      first,
      nearIndex(anchors.dueAnchorDate, anchors.intervalMonths, from),
    );
    i <= 120000;
    i++
  ) {
    const date = add(anchors.dueAnchorDate, i * anchors.intervalMonths);
    if (date > through) break;
    if (date >= from) indices.push(i);
    if (indices.length > 38) throw new RangeError("Forecast window too large");
  }
  return indices;
}
export function validateWindow(from: string, through: string) {
  if (through < from || through > add(from, 36))
    throw new RangeError("Invalid forecast window");
}
export function horizon(now: Date, calendar: CalendarPolicy) {
  return add(localToday(now, calendar), 36);
}
export function periodInstants(dueDate: string, calendar: CalendarPolicy) {
  const due = Temporal.PlainDate.from(dueDate);
  const readiness = due.subtract({ days: 21 });
  function at(
    date: Temporal.PlainDate,
    hour: number,
    minute = 0,
    second = 0,
  ): string | null {
    try {
      return Temporal.ZonedDateTime.from(
        {
          timeZone: calendar.timeZone,
          year: date.year,
          month: date.month,
          day: date.day,
          hour,
          minute,
          second,
        },
        { disambiguation: "reject" },
      )
        .toInstant()
        .toString();
    } catch {
      return null;
    }
  }
  return {
    readinessDate: readiness.toString(),
    issueAt: at(readiness, calendar.issueHour),
    chargeAt: at(due, calendar.chargeHour),
    dueEndAt: at(due, 23, 59, 59),
  };
}
