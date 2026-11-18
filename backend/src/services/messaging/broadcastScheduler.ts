/**
 * Starts broadcasts whose scheduled time has arrived.
 *
 * `SmsBroadcast.scheduledAt` has existed since the module was ported, and a
 * scheduled campaign was stored as QUEUED — but nothing ever read the column.
 * A broadcast scheduled for 10am sat in QUEUED indefinitely and never sent,
 * with no error anywhere to say so. This is the missing half.
 *
 * Polling rather than a BullMQ delayed job, on purpose:
 *
 *   A delayed job is created once, at schedule time. Rescheduling, cancelling
 *   or approving a campaign afterwards would have to find and rewrite that job,
 *   and a Redis flush would lose every pending campaign silently. Polling makes
 *   the database the single source of truth — whatever is due and approved
 *   right now is what goes out, however it got that way.
 *
 * The tick is cheap: one indexed query on (status, scheduledAt) per minute.
 */
import prisma from '../../config/prismaClient';
import { BroadcastStateError, startBroadcast } from './broadcast.service';
import { recoverStalledBroadcasts } from '../../workers/smsBroadcastWorker';

const INTERVAL_MS = Number(process.env.BROADCAST_SCHEDULER_INTERVAL_MS ?? '60000');

/**
 * How far back a missed schedule is still honoured.
 *
 * If the process was down over a window, a campaign scheduled for 10:00 should
 * still go out when it comes back at 10:05. But it should NOT go out at 4pm —
 * a marketing blast landing six hours late is worse than one that never sent,
 * and the operator can reschedule. Anything past the grace period is left in
 * QUEUED for a human to decide on.
 */
const MAX_LATENESS_MS = Number(process.env.BROADCAST_SCHEDULER_GRACE_MS ?? String(60 * 60 * 1000));

let timer: NodeJS.Timeout | null = null;
/** Guards against a slow tick overlapping the next one. */
let running = false;

/**
 * Start every broadcast that is due. Returns how many were started, so this is
 * assertable in a test rather than only observable through logs.
 */
export async function runDueBroadcasts(now: Date = new Date()): Promise<number> {
  const due = await prisma.smsBroadcast.findMany({
    where: {
      status: 'QUEUED',
      scheduledAt: {
        not: null,
        lte: now,
        gte: new Date(now.getTime() - MAX_LATENESS_MS),
      },
    },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true, name: true, scheduledAt: true },
  });

  let started = 0;

  for (const broadcast of due) {
    try {
      const result = await startBroadcast(broadcast.id);
      started += 1;
      console.log(
        `[messaging:scheduler] started "${broadcast.name}" (${result.recipients} recipients, ${result.chunks} chunks)`,
      );
    } catch (err) {
      // One broken campaign must not stop the rest of the window from going
      // out, but a failed start must not kill the campaign either:
      //   - BroadcastStateError means another instance (or a manual Start)
      //     already claimed it — the campaign is fine, just not ours.
      //   - Anything else (Redis blip, DB timeout) left the row in QUEUED, so
      //     the next tick retries it until the grace period runs out.
      // Marking FAILED here used to stop campaigns mid-send whenever two API
      // instances raced on the same due row.
      if (err instanceof BroadcastStateError) continue;
      console.error(`[messaging:scheduler] failed to start "${broadcast.name}", will retry:`, (err as Error)?.message);
    }
  }

  return started;
}

export function startBroadcastScheduler(): void {
  if (timer) return;

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runDueBroadcasts()
      .then(() => recoverStalledBroadcasts())
      .catch((err) => console.error('[messaging:scheduler] tick failed:', (err as Error)?.message))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);

  // Never hold the process open just for the scheduler.
  timer.unref?.();

  console.log(`[messaging:scheduler] polling for due broadcasts every ${Math.round(INTERVAL_MS / 1000)}s`);
}

export function stopBroadcastScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
