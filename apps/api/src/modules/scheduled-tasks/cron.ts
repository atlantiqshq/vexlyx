import { CronExpressionParser } from "cron-parser";

/** Returns an explanation if the expression can't be scheduled, or null when it can. */
export function explainInvalidSchedule(schedule: string, tz: string): string | null {
  try {
    CronExpressionParser.parse(schedule, { tz }).next();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Not a valid cron expression";
  }
}

/** The next `count` run times after `from`, evaluated in `tz`. Empty if the expression never fires. */
export function nextRuns(schedule: string, tz: string, count: number, from: Date = new Date()): Date[] {
  try {
    const iterator = CronExpressionParser.parse(schedule, { tz, currentDate: from });
    const runs: Date[] = [];
    for (let i = 0; i < count; i += 1) runs.push(iterator.next().toDate());
    return runs;
  } catch {
    return [];
  }
}
