import { PgBoss } from "pg-boss";
import type {
  ScheduledBilling,
  ScheduleSweepInput,
} from "../billing/scheduled-types";
import type { BillingCommands, PendingWork } from "../billing/types";
import type { InvoiceResolutions } from "../billing/resolutions-types";
import type { PaymentSettings } from "../billing/payment-settings-types";
type BillingWork =
  | PendingWork
  | { kind: "resolution"; resolutionId: string }
  | { kind: "payment_setup"; setupId: string };

const queue = "datapad-billing";
interface BillingWorker {
  enqueue(work: BillingWork): Promise<void>;
  stop(): Promise<void>;
}

/** Pending database obligations recover a lost enqueue or exhausted queue retry. */
export async function createBillingWorker(options: {
  databaseUrl: string;
  billing: Pick<
    BillingCommands,
    "pendingWork" | "issueInvoice" | "processEvent"
  >;
  scheduled?: Pick<ScheduledBilling, "sweepScheduled">;
  resolutions?: Pick<
    InvoiceResolutions,
    "pendingResolutions" | "processResolution"
  >;
  paymentSettings?: Pick<PaymentSettings, "pendingSetups" | "processSetup">;
  onError?: () => void;
}): Promise<BillingWorker> {
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schedule: false,
  });
  const report = () => options.onError?.();
  boss.on("error", report);
  let stopped = false;
  let sweeping: Promise<void> | undefined;
  let scheduleCursor: Pick<ScheduleSweepInput, "after" | "through"> = {};
  async function enqueue(work: BillingWork) {
    if (stopped) throw new Error("Billing worker stopped.");
    const singletonKey =
      work.kind === "issue"
        ? `issue:${work.invoiceId}`
        : work.kind === "event"
          ? `event:${work.eventId}`
          : work.kind === "resolution"
            ? `resolution:${work.resolutionId}`
            : `payment_setup:${work.setupId}`;
    await boss.send(queue, work, { singletonKey });
  }
  async function sweep() {
    if (stopped || sweeping) return sweeping;
    sweeping = (async () => {
      if (options.scheduled) {
        try {
          const page = await options.scheduled.sweepScheduled(scheduleCursor);
          scheduleCursor = page.next
            ? { after: page.next, through: page.through }
            : {};
          if (page.results.some((result) => result.failure !== null)) report();
        } catch {
          report();
        }
      }
      for (const work of (await options.resolutions?.pendingResolutions(100)) ??
        []) {
        if (stopped) return;
        await enqueue(work);
      }
      for (const setupId of (await options.paymentSettings?.pendingSetups(
        100,
      )) ?? []) {
        if (stopped) return;
        await enqueue({ kind: "payment_setup", setupId });
      }
      for (const work of await options.billing.pendingWork(100)) {
        if (stopped) return;
        await enqueue(work);
      }
    })();
    try {
      await sweeping;
    } finally {
      sweeping = undefined;
    }
  }
  try {
    await boss.start();
    await boss.createQueue(queue, {
      policy: "exclusive",
      retryLimit: 4,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 300,
    });
    await boss.work<BillingWork>(queue, { batchSize: 1 }, async ([job]) => {
      const work = job.data;
      if (work.kind === "issue")
        await options.billing.issueInvoice(work.invoiceId);
      else if (work.kind === "event")
        await options.billing.processEvent(work.eventId);
      else if (work.kind === "resolution" && options.resolutions)
        await options.resolutions.processResolution(work.resolutionId);
      else if (work.kind === "payment_setup" && options.paymentSettings)
        await options.paymentSettings.processSetup(work.setupId);
      else throw new Error("Billing work capability unavailable.");
      // The domain persists nextAttemptAt. The sweep sends only eligible work.
      // A retry result completes this delivery; throwing retries operational failures.
    });
    await sweep();
  } catch {
    stopped = true;
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(report);
    throw new Error("Billing worker unavailable.");
  }
  const timer = setInterval(() => {
    void sweep().catch(report);
  }, 5000);
  return {
    enqueue,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([sweeping]);
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}
