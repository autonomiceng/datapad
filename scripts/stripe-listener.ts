const invoiceEvents = [
  "invoice.created",
  "invoice.updated",
  "invoice.finalized",
  "invoice.finalization_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
];

/** The caller owns shutdown of the returned child, including on startup failure. */
export function startStripeListener({
  secretKey,
  forwardTo,
  configPath,
}: {
  secretKey: string;
  forwardTo: string;
  configPath: string;
}) {
  const child = Bun.spawn(
    [
      "stripe",
      "listen",
      "--events-from",
      "@self",
      "--events",
      invoiceEvents.join(","),
      "--forward-to",
      forwardTo,
      "--skip-update",
      "--config",
      configPath,
    ],
    {
      env: { ...process.env, STRIPE_API_KEY: secretKey },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  );
  let accept: (secret: string) => void;
  let reject: (error: Error) => void;
  const ready = new Promise<string>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const timeout = setTimeout(
    () => reject(new Error("Stripe webhook listener startup timed out.")),
    30_000,
  );
  async function consume(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending = (pending + decoder.decode(chunk, { stream: true })).slice(
        -8192,
      );
      const match = /\bwhsec_[A-Za-z0-9]+(?=\s|\.)/.exec(pending);
      if (match) accept(match[0]);
      // Listener output contains a signing secret and provider details. Drain it privately.
    }
  }
  void Promise.all([consume(child.stdout), consume(child.stderr)]).catch(() =>
    reject(new Error("Stripe webhook listener output failed.")),
  );
  void child.exited.then(() =>
    reject(new Error("Stripe webhook listener exited before becoming ready.")),
  );
  return {
    child,
    ready: ready.finally(() => clearTimeout(timeout)),
  };
}
