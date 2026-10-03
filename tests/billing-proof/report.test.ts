import { expect, test } from "bun:test";
import type { Manifest } from "../../scripts/billing-proof/core.ts";
import { renderReport } from "../../scripts/billing-proof/report.ts";

test("report escapes source labels and omits private operations and unsafe links", () => {
  const manifest: Manifest = {
    schemaVersion: 1,
    runId: "synthetic-report",
    createdAt: "2030-01-01T00:00:00Z",
    timezone: "UTC",
    clock: { frozenTime: 1893456000, status: "ready" },
    customers: {},
    operations: {
      private: {
        id: "private",
        kind: "invoice",
        intent: { secret: "must-stay-private" },
        state: "pending",
      },
    },
    events: [
      {
        at: "2030-01-01T00:00:00Z",
        clockTime: 1893456000,
        kind: "test",
        message: "<script>unsafe()</script>",
      },
    ],
    groups: [
      {
        id: "manual",
        customer: "manual",
        scenario: "manual",
        dueDate: "2030-01-22",
        readyDate: "2030-01-01",
        chargeAt: 1895270400,
        lines: [
          {
            id: "one",
            description: "<img src=x onerror=unsafe()>",
            amount: 1200,
          },
        ],
        invoice: {
          id: "in_synthetic",
          status: "open",
          amountDue: 1200,
          amountPaid: 0,
          attemptCount: 0,
          hostedInvoiceUrl: "https://invoice.stripe.com.attacker.test/unsafe",
          invoicePdf: null,
          dueDate: 1895270400,
          created: 1893456000,
          finalizedAt: 1893456000,
          lineCount: 1,
          paymentCount: 0,
          observedAt: 1893456000,
        },
      },
    ],
  };
  const html = renderReport(manifest);
  expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=unsafe()&gt;");
  expect(html).not.toContain("must-stay-private");
  expect(html).not.toContain("attacker.test");
  expect(html).toContain("$12.00");
  manifest.groups[0]!.invoice!.hostedInvoiceUrl =
    "https://invoice.stripe.com/i/test_synthetic";
  expect(renderReport(manifest)).toContain(
    'href="https://invoice.stripe.com/i/test_synthetic"',
  );
});
