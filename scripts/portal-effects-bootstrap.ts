import type { AccessSessionResponse } from "../src/access/contract";
import type { BillingOperationsResponse } from "../src/billing/operations-contract";

/** Signs in through the owned local inbox and consumes one stable synthetic resume command; a later staff pause is preserved. */
export async function bootstrapPortalEffects(options: {
  localOrigin: string;
  origin: string;
  inbox: string;
}) {
  const { localOrigin, origin, inbox } = options;
  const local = new URL(localOrigin),
    mailbox = new URL(inbox);
  if (
    local.protocol !== "http:" ||
    local.hostname !== "127.0.0.1" ||
    mailbox.protocol !== "http:" ||
    mailbox.hostname !== "127.0.0.1"
  )
    throw new Error("Synthetic bootstrap requires owned loopback listeners.");
  const request = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const headers = { origin, "content-type": "application/json" };
  const before = await request(`${inbox}/api/v1/messages`);
  if (!before.ok) throw new Error("Synthetic inbox unavailable.");
  const oldMessages: { messages: Array<{ ID: string }> } = await before.json();
  const previous = new Set(oldMessages.messages.map((message) => message.ID));
  const send = await request(`${localOrigin}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "staff@example.test",
      callbackURL: `${origin}/customers`,
    }),
  });
  if (!send.ok) throw new Error("Synthetic staff sign-in failed.");
  let link: string | undefined;
  for (let attempt = 0; attempt < 40 && !link; attempt++) {
    const response = await request(`${inbox}/api/v1/messages`);
    if (!response.ok) throw new Error("Synthetic inbox unavailable.");
    const body: {
      messages: Array<{
        ID: string;
        Subject: string;
        To: Array<{ Address: string }>;
      }>;
    } = await response.json();
    const message = body.messages.find(
      (entry) =>
        !previous.has(entry.ID) &&
        entry.Subject === "Sign in to the Datapad sample portal" &&
        entry.To.some((to) => to.Address === "staff@example.test"),
    );
    if (message) {
      const content = await request(
        `${inbox}/api/v1/message/${encodeURIComponent(message.ID)}`,
      );
      const value: { Text: string } = await content.json();
      link = value.Text.match(
        /https?:\/\/[^\s]+\/api\/auth\/magic-link\/verify[^\s]+/,
      )?.[0];
    }
    if (!link) await Bun.sleep(100);
  }
  if (!link) throw new Error("Synthetic sign-in message missing.");
  const verify = new URL(link);
  if (
    verify.origin !== origin ||
    verify.pathname !== "/api/auth/magic-link/verify"
  )
    throw new Error("Unexpected synthetic sign-in destination.");
  const signed = await request(
    `${localOrigin}${verify.pathname}${verify.search}`,
    { headers: { origin }, redirect: "manual" },
  );
  const cookies = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookies)
    throw new Error("Synthetic sign-in did not establish a session.");
  const authenticated = { ...headers, cookie: cookies };
  let failure: unknown;
  try {
    const response = await request(`${localOrigin}/api/access/session`, {
      headers: authenticated,
    });
    const session: AccessSessionResponse = await response.json();
    if (
      !response.ok ||
      !session.synthetic ||
      session.user?.id !== "sample-staff" ||
      !session.staffRoles.includes("billing")
    )
      throw new Error("Unexpected synthetic billing authority.");
    const result = await request(
      `${localOrigin}/api/billing/operations/control`,
      {
        method: "POST",
        headers: authenticated,
        body: JSON.stringify({
          requestId: "6a9d2a66-421d-4779-8f27-b33e06a475bd",
          expectedVersion: 0,
          paused: false,
          reason: "Enable this owned synthetic portal once",
        }),
      },
    );
    if (result.status === 409) {
      const existing = await request(`${localOrigin}/api/billing/operations`, {
        headers: authenticated,
      });
      const state: BillingOperationsResponse = await existing.json();
      if (!existing.ok || state.control.version === 0)
        throw new Error("Synthetic resume identity conflict.");
      // An earlier explicit control takes precedence; never override it at startup.
    } else if (!result.ok)
      throw new Error("Synthetic financial bootstrap failed.");
  } catch (error) {
    failure = error;
  }
  try {
    const signedOut = await request(`${localOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: authenticated,
      body: "{}",
    });
    if (!signedOut.ok) throw new Error("Synthetic bootstrap sign-out failed.");
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}
