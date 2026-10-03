import type { InvoiceNotices, NoticeSweepInput } from "../notifications/types";
import { PgBoss } from "pg-boss";
import type {
  ScheduledBilling,
  ScheduleSweepInput,
} from "../billing/scheduled-types";
import type {
  BillingCommands,
  PendingWork,
  ReconciliationCursor,
} from "../billing/types";
import type { InvoiceResolutions } from "../billing/resolutions-types";
import type { InvoiceCollections } from "../billing/collection-types";
import type { PaymentSettings } from "../billing/payment-settings-types";
type BillingWork =
  | PendingWork
  | { kind: "resolution"; resolutionId: string }
  | { kind: "payment_setup"; setupId: string }
  | { kind: "collection"; invoiceId: string }
  | { kind: "notice"; noticeId: string };

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
  collections?: Pick<
    InvoiceCollections,
    "pendingCollections" | "collectDueInvoice"
  >;
  notices?: Pick<InvoiceNotices, "sweepNotices" | "processNotice">;
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
  let collectionCursor: {
    after?: ReconciliationCursor | null;
    through?: ReconciliationCursor | null;
  } = {};
  let noticeCursor: NoticeSweepInput = {};
  async function enqueue(work: BillingWork) {
    if (stopped) throw new Error("Billing worker stopped.");
    const singletonKey =
      work.kind === "issue"
        ? `issue:${work.invoiceId}`
        : work.kind === "event"
          ? `event:${work.eventId}`
          : work.kind === "collection"
            ? `collection:${work.invoiceId}`
            : work.kind === "notice"
              ? `notice:${work.noticeId}`
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
      if (options.collections) {
        try {
          const page = await options.collections.pendingCollections({
            ...collectionCursor,
            limit: 100,
          });
          // Advance the bounded pass even if a delivery fails. Durable work returns next pass.
          collectionCursor = page.next
            ? { after: page.next, through: page.through }
            : {};
          for (const invoiceId of page.invoiceIds) {
            if (stopped) return;
            await enqueue({ kind: "collection", invoiceId }).catch(report);
          }
        } catch {
          report();
        }
      }
      if (options.notices) {
        try {
          const page = await options.notices.sweepNotices(noticeCursor);
          noticeCursor = { discovery: page.discovery, pending: page.pending };
          for (const noticeId of page.noticeIds) {
            if (stopped) return;
            await enqueue({ kind: "notice", noticeId }).catch(report);
          }
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
      else if (work.kind === "notice" && options.notices)
        await options.notices.processNotice(work.noticeId);
      else if (work.kind === "collection" && options.collections)
        await options.collections.collectDueInvoice(work.invoiceId);
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
