import { expect, test } from "bun:test";
import Stripe from "stripe";
import { createApp } from "../../src/server/app";
import { createStripeEventVerifier } from "../../src/stripe";
import type { ImportReviewReader } from "../../src/import-review";

const unused = async (): Promise<never> => {
  throw new Error("Unexpected import read.");
};
const importReview: ImportReviewReader = {
  listSources: unused,
  listImports: unused,
  listCustomers: unused,
  getCustomer: unused,
  listDataIssues: unused,
};

test("billing HTTP bounds reads and commits signed raw events before acknowledgement", async () => {
  const signingSecret = "whsec_synthetic";
  const ownership = {
    deploymentKey: "synthetic-http",
    accountId: "acct_synthetic",
  };
  let accepted = 0;
  let unavailable = false;
  const app = createApp({
    importReview,
    billing: {
      reader: {
        listInvoices: async () => ({
          invoices: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        getInvoice: async () => null,
      },
      webhook: {
        verifier: createStripeEventVerifier({ signingSecret, ownership }),
        acceptEvent: async () => {
          if (unavailable) throw new Error("private storage failure");
          accepted++;
          return "accepted";
        },
      },
    },
  });
  const read = await app.handle(
    new Request("http://localhost/api/billing/invoices"),
  );
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({
    invoices: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
  for (const suffix of [
    "?limit=101",
    "?offset=-1",
    "?private=value",
    "/invalid",
  ]) {
    const invalid = await app.handle(
      new Request(`http://localhost/api/billing/invoices${suffix}`),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ code: "invalid_request" });
  }
  const missing = await app.handle(
    new Request(
      "http://localhost/api/billing/invoices/00000000-0000-4000-8000-000000000000",
    ),
  );
  expect(missing.status).toBe(404);
  const body = JSON.stringify(
    {
      id: "evt_synthetic",
      object: "event",
      type: "invoice.paid",
      livemode: false,
      created: 1791000000,
      data: {
        object: {
          id: "in_synthetic",
          object: "invoice",
          metadata: {
            datapad_deployment: ownership.deploymentKey,
            datapad_invoice: "00000000-0000-4000-8000-000000000000",
          },
        },
      },
    },
    null,
    2,
  );
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret: signingSecret,
  });
  const post = (payload: string, signed: string = signature) =>
    app.handle(
      new Request("http://localhost/api/billing/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signed,
        },
        body: payload,
      }),
    );
  expect((await post(body)).status).toBe(200);
  expect(accepted).toBe(1);
  expect((await post(body + " ")).status).toBe(400);
  const replacementBody = body.replace("evt_synthetic", "evt_synthetic_�");
  const replacementSignature =
    await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: replacementBody,
      secret: signingSecret,
    });
  const malformed = new TextEncoder().encode(replacementBody);
  const position = malformed.indexOf(0xef);
  const altered = new Uint8Array(malformed.length - 2);
  altered.set(malformed.subarray(0, position));
  altered[position] = 0xff;
  altered.set(malformed.subarray(position + 3), position + 1);
  const invalidBytes = await app.handle(
    new Request("http://localhost/api/billing/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": replacementSignature,
      },
      body: altered,
    }),
  );
  expect(invalidBytes.status).toBe(400);

  expect((await post("x".repeat(1024 * 1024 + 1))).status).toBe(413);
  unavailable = true;
  const failure = await post(body);
  expect(failure.status).toBe(503);
  expect(await failure.json()).toEqual({ code: "unavailable" });
  expect(accepted).toBe(1);
});
