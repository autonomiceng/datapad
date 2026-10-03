import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import Stripe from "stripe";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calendar,
  createManifest,
  Probe,
  ProofError,
  testObject,
  type Group,
} from "../../scripts/billing-proof/core.ts";
import {
  atomicWrite,
  openRun,
  readConfig,
} from "../../scripts/billing-proof/store.ts";

function fakeClient(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) {
  return Stripe.createFetchHttpClient(
    Object.assign(handler, { preconnect: () => {} }),
  );
}

const noNetwork = new Stripe("sk_test_synthetic", {
  httpClient: fakeClient(async () => {
    throw new Error("Unexpected provider request");
  }),
  maxNetworkRetries: 0,
});
const save = async () => {};

test("same-date lines group, zero groups stay visible, and calendar readiness spans DST", () => {
  const manifest = createManifest("2026-10-01");
  const automatic = manifest.groups.find((group) => group.id === "automatic")!;
  expect(automatic.lines.map((line) => line.amount)).toEqual([1200, 300, 0]);
  expect(automatic.dueDate).toBe("2026-10-22");
  expect(manifest.groups.find((group) => group.id === "early")?.dueDate).toBe(
    "2026-10-23",
  );
  expect(manifest.groups.find((group) => group.id === "zero")?.action).toBe(
    "No charge",
  );
  const spring = calendar("2026-03-22", "America/New_York");
  expect(spring.readyDate).toBe("2026-03-01");
  expect(spring.chargeAt - spring.readyAt).toBe((21 * 24 + 8) * 3600);
});

test("interrupted creation reconciles its receipt without sending another create", async () => {
  const manifest = createManifest("2026-10-01");
  let durable = "";
  let creates = 0;
  const result = {
    id: "in_synthetic",
    livemode: false,
    lineCount: 3,
    paymentCount: 0,
  };
  const crashed = new Probe(
    noNetwork,
    manifest,
    async () => {
      durable = JSON.stringify(manifest);
    },
    true,
  );
  const create = async () => {
    creates++;
    return result;
  };
  await rejects(
    crashed.operation(
      "invoice:automatic",
      "invoice",
      { due: 123 },
      create,
      async () => result,
      testObject,
    ),
    /Injected interruption/,
  );
  expect(
    JSON.parse(durable).operations["invoice:automatic"].objectId,
  ).toBeUndefined();
  const recovered = new Probe(noNetwork, manifest, save);
  expect(
    await recovered.operation(
      "invoice:automatic",
      "invoice",
      { due: 123 },
      create,
      async () => result,
      testObject,
    ),
  ).toEqual(result);
  expect(
    await recovered.operation(
      "invoice:automatic",
      "invoice",
      { due: 123 },
      create,
      async () => result,
      testObject,
    ),
  ).toEqual(result);
  expect(creates).toBe(1);
});

test("ambiguous empty reconciliation, changed intent and live responses fail closed", async () => {
  const manifest = createManifest("2026-10-01");
  let creates = 0;
  const probe = new Probe(noNetwork, manifest, save);
  const create = async (): Promise<{ id: string; livemode: boolean }> => {
    creates++;
    throw new Error("uncertain network result");
  };
  await rejects(
    probe.operation(
      "invoice:manual",
      "invoice",
      { amount: 1000 },
      create,
      async () => undefined,
      testObject,
    ),
  );
  await rejects(
    probe.operation(
      "invoice:manual",
      "invoice",
      { amount: 1000 },
      create,
      async () => undefined,
      testObject,
    ),
    /could not be reconciled/,
  );
  await rejects(
    probe.operation(
      "invoice:manual",
      "invoice",
      { amount: 2000 },
      create,
      async () => undefined,
      testObject,
    ),
    /intent changed/,
  );
  expect(creates).toBe(1);
  expect(() => testObject({ livemode: true })).toThrow("non-test object");
});

test("prepare rejects new invoice intents at or past due time and reconciles existing ones", async () => {
  const manifest = createManifest("2026-10-01");
  manifest.clock.id = "clock_synthetic";
  manifest.customers.manual = "cus_synthetic";
  const group = manifest.groups[0];
  manifest.groups = [group];
  let now = group.chargeAt;
  let creates = 0;
  let lineCreated = false;
  let finalized = false;
  const invoice = () => ({
    id: "in_synthetic",
    livemode: false,
    metadata: {
      proof_run: manifest.runId,
      proof_operation: `invoice:${group.id}`,
    },
    customer: manifest.customers.manual,
    test_clock: manifest.clock.id,
    collection_method: "send_invoice",
    auto_advance: false,
    due_date: group.chargeAt,
    currency: "usd",
    status: finalized ? "open" : "draft",
    amount_due: 1000,
    amount_paid: 0,
    attempt_count: 0,
    created: group.chargeAt - 1,
    status_transitions: { finalized_at: finalized ? now : null },
    lines: { data: lineCreated ? group.lines : [], has_more: false },
    total: lineCreated ? 1000 : 0,
    hosted_invoice_url: finalized ? "https://invoice.stripe.com/i/test" : null,
  });
  const sdk = new Stripe("sk_test_synthetic", {
    maxNetworkRetries: 0,
    httpClient: fakeClient(async (input, init) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname;
      if (path.includes("test_clocks"))
        return Response.json({
          id: manifest.clock.id,
          livemode: false,
          name: `datapad-proof:${manifest.runId}`,
          frozen_time: now,
          status: "ready",
        });
      if (path === "/v1/customers/cus_synthetic")
        return Response.json({
          id: "cus_synthetic",
          livemode: false,
          metadata: {
            proof_run: manifest.runId,
            proof_operation: "customer:manual",
          },
          test_clock: manifest.clock.id,
        });
      if (path === "/v1/invoices") {
        if (init?.method === "POST") {
          creates++;
          return Response.json(invoice());
        }
        return Response.json({ data: [invoice()], has_more: false });
      }
      if (path === "/v1/invoiceitems") {
        lineCreated = true;
        return Response.json({
          id: "ii_synthetic",
          livemode: false,
          metadata: {
            proof_run: manifest.runId,
            proof_operation: `line:${group.id}:${group.lines[0].id}`,
          },
          invoice: "in_synthetic",
          amount: 1000,
        });
      }
      if (path === "/v1/invoices/in_synthetic/finalize") finalized = true;
      if (path.startsWith("/v1/invoices/in_synthetic"))
        return Response.json(invoice());
      if (path === "/v1/invoice_payments")
        return Response.json({ data: [], has_more: false });
      throw new ProofError("Unexpected fixture request.");
    }),
  });
  const probe = new Probe(sdk, manifest, save);
  for (now of [group.chargeAt, group.chargeAt + 1]) {
    await rejects(probe.prepare(), /Readiness window has passed/);
    expect(creates).toBe(0);
    expect(manifest.operations).toEqual({});
  }
  now = group.chargeAt - 1;
  await rejects(
    new Probe(sdk, manifest, save, true).prepare(),
    /Injected interruption/,
  );
  expect(manifest.operations[`invoice:${group.id}`].state).toBe("uncertain");
  now = group.chargeAt + 1;
  await probe.prepare();
  expect(creates).toBe(1);
  expect(manifest.operations[`invoice:${group.id}`].state).toBe("done");
  expect(group.invoice?.id).toBe("in_synthetic");
  expect(group.invoice?.status).toBe("open");
});

test("private store rejects checkout paths, live keys, loose permissions and concurrent owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), ".datapad-proof-test-"));
  try {
    const config = join(directory, "sandbox.env");
    await writeFile(config, "STRIPE_SECRET_KEY=sk_live_synthetic\n", {
      mode: 0o600,
    });
    await rejects(readConfig(config), /live credentials/);
    await writeFile(config, "STRIPE_SECRET_KEY=sk_test_synthetic\n");
    expect(await readConfig(config)).toBe("sk_test_synthetic");
    await chmod(config, 0o644);
    await rejects(readConfig(config), /permissions/);
    const run = await openRun(join(directory, "run"));
    try {
      await rejects(openRun(join(directory, "run")), /locked/);
      const manifest = createManifest("2026-10-01");
      await atomicWrite(
        run.directory,
        "manifest.json",
        JSON.stringify(manifest),
      );
      expect(await run.read()).toEqual(manifest);
    } finally {
      await run.release();
    }
    await mkdir(join(directory, ".git"));
    await rejects(openRun(join(directory, "forbidden")), /outside every Git/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function view(
  group: Group,
  status: "open" | "paid" | "void" = "open",
): NonNullable<Group["invoice"]> {
  return {
    id: `in_${group.id}`,
    status,
    amountDue: 1000,
    amountPaid: status === "paid" ? 1000 : 0,
    attemptCount: 0,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
    invoicePdf: null,
    dueDate: group.chargeAt,
    created: 0,
    finalizedAt: 0,
    lineCount: group.lines.length,
    paymentCount: 1,
    observedAt: 0,
  };
}

test("collection retrieves current state, respects due time and terminal invoices, and pays once", async () => {
  const manifest = createManifest("2026-10-01");
  manifest.clock.id = "clock_synthetic";
  manifest.customers.automatic = "cus_synthetic";
  const groups = manifest.groups.filter((group) =>
    ["automatic", "early", "void"].includes(group.id),
  );
  manifest.groups = groups;
  for (const group of groups) group.invoice = view(group);
  let now = groups[0].chargeAt - 1;
  let payCalls = 0;
  let automaticPaid = false;
  const sdk = new Stripe("sk_test_synthetic", {
    maxNetworkRetries: 0,
    httpClient: fakeClient(async (input, init) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname;
      let body: unknown;
      if (path.includes("test_clocks"))
        body = {
          id: manifest.clock.id,
          livemode: false,
          name: `datapad-proof:${manifest.runId}`,
          frozen_time: now,
          status: "ready",
        };
      else if (path === "/v1/invoice_payments")
        body = { data: [], has_more: false };
      else if (path.startsWith("/v1/invoices/")) {
        const group = groups.find((group) => path.includes(`in_${group.id}`))!;
        if (path.endsWith("/pay")) {
          payCalls++;
          automaticPaid = true;
          expect(typeof init?.body === "string" ? init.body : "").toContain(
            "off_session=true",
          );
        }
        const status =
          group.id === "early" || (group.id === "automatic" && automaticPaid)
            ? "paid"
            : group.id === "void"
              ? "void"
              : "open";
        body = {
          id: `in_${group.id}`,
          livemode: false,
          metadata: {
            proof_run: manifest.runId,
            proof_operation: `invoice:${group.id}`,
          },
          customer: "cus_synthetic",
          test_clock: manifest.clock.id,
          collection_method: "send_invoice",
          auto_advance: false,
          due_date: group.chargeAt,
          currency: "usd",
          status,
          amount_due: 1500,
          amount_remaining: status === "open" ? 1500 : 0,
          amount_paid: status === "paid" ? 1500 : 0,
          attempt_count: payCalls,
          created: 0,
          status_transitions: { finalized_at: 0 },
          lines: { data: group.lines },
        };
      } else throw new ProofError("Unexpected fixture request.");
      return Response.json(body);
    }),
  });
  const probe = new Probe(sdk, manifest, save);
  // Payment setup is independently guarded by ownership checks; this case isolates invoice collection.
  probe.paymentMethod = async () => "pm_synthetic";
  await probe.collect();
  expect(payCalls).toBe(0);
  now = groups[2].chargeAt + 3600;
  await probe.collect();
  await probe.collect();
  expect(payCalls).toBe(1);
  expect(groups[1].invoice?.status).toBe("paid");
  expect(groups[2].invoice?.status).toBe("void");
});

test("decline and authentication errors remain unpaid with no automatic retry", async () => {
  const manifest = createManifest("2026-10-01");
  manifest.clock.id = "clock_synthetic";
  manifest.customers.automatic = "cus_synthetic";
  manifest.groups = manifest.groups.filter((group) =>
    ["decline", "authentication"].includes(group.id),
  );
  for (const group of manifest.groups) group.invoice = view(group);
  let attempts = 0;
  const sdk = new Stripe("sk_test_synthetic", {
    maxNetworkRetries: 0,
    httpClient: fakeClient(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname.includes("test_clocks"))
        return Response.json({
          id: manifest.clock.id,
          livemode: false,
          name: `datapad-proof:${manifest.runId}`,
          frozen_time: manifest.groups[1].chargeAt,
          status: "ready",
        });
      if (url.pathname === "/v1/invoice_payments")
        return Response.json({ data: [], has_more: false });
      const group = manifest.groups.find((group) =>
        url.pathname.includes(`in_${group.id}`),
      )!;
      if (url.pathname.endsWith("/pay")) {
        attempts++;
        return Response.json(
          {
            error: {
              type: "card_error",
              code:
                group.id === "decline"
                  ? "card_declined"
                  : "authentication_required",
              message: "Synthetic failure",
            },
          },
          { status: 402 },
        );
      }
      return Response.json({
        id: `in_${group.id}`,
        livemode: false,
        metadata: {
          proof_run: manifest.runId,
          proof_operation: `invoice:${group.id}`,
        },
        customer: "cus_synthetic",
        test_clock: manifest.clock.id,
        collection_method: "send_invoice",
        auto_advance: false,
        due_date: group.chargeAt,
        currency: "usd",
        status: "open",
        amount_due: 1000,
        amount_remaining: 1000,
        amount_paid: 0,
        attempt_count: 1,
        created: 0,
        status_transitions: { finalized_at: 0 },
        lines: { data: group.lines },
      });
    }),
  });
  const probe = new Probe(sdk, manifest, save);
  probe.paymentMethod = async () => "pm_synthetic";
  await probe.collect();
  await probe.collect();
  expect(attempts).toBe(2);
  expect(manifest.groups[0].action).toContain("declined");
  expect(manifest.groups[1].action).toContain("Authentication required");
  expect(
    manifest.groups.every((group) => group.invoice?.status === "open"),
  ).toBe(true);
});
