import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Group, Manifest } from "./core.ts";

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]!;
  });
}

function money(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount / 100);
}

/** UTC to the minute; the footer states the zone once. */
function instant(value: number): string {
  return new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Shows only the time when it falls on the planned date beside it. */
function timeOn(value: number, date: string): string {
  const text = instant(value);
  return text.startsWith(date) ? text.slice(11) : text;
}

function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hostedLink(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "invoice.stripe.com" ||
      url.username ||
      url.password
    )
      return "";
    return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">Open test invoice<span class="sr-only"> (new tab)</span></a>`;
  } catch {
    return "";
  }
}

function title(group: Group): string {
  return {
    manual: "Manual payment",
    automatic: "Combined invoice",
    early: "Early payment",
    decline: "Declined card",
    authentication: "Authentication required",
    void: "Voided invoice",
    zero: "Free services",
  }[group.scenario];
}

function row(group: Group): string {
  const invoice = group.invoice;
  const name = title(group);
  const amount = group.lines.reduce((total, line) => total + line.amount, 0);
  const status =
    amount === 0 ? "No charge" : sentence(invoice?.status ?? "Not created");
  const payment =
    group.customer === "automatic" ? "Automatic payment" : "Manual payment";
  // Only an unsettled invoice with an operator note is a warning; paid and void notes are context.
  const warning =
    Boolean(group.action) &&
    amount > 0 &&
    invoice?.status !== "paid" &&
    invoice?.status !== "void";
  const tone = warning ? "warning" : invoice?.status === "paid" ? "paid" : "";
  const note =
    group.action && group.action.toLowerCase() !== status.toLowerCase()
      ? `<span class="${warning ? "note warning" : "support"}">${escape(group.action)}</span>`
      : "";
  const evidence = [
    hostedLink(invoice?.hostedInvoiceUrl),
    invoice ? `Retrieved ${escape(instant(invoice.observedAt))}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const services = group.lines
    .map(
      (line) =>
        `<li>${escape(line.description)}${group.lines.length > 1 ? ` <span>${escape(money(line.amount))}</span>` : ""}</li>`,
    )
    .join("");
  return `<tr>
      <th scope="row">${escape(name)}${payment === name || amount === 0 ? "" : `<span class="support">${payment}</span>`}<ul>${services}</ul></th>
      <td data-label="Ready"><div>${escape(group.readyDate)}${invoice?.finalizedAt ? `<span class="support">Finalized ${escape(timeOn(invoice.finalizedAt, group.readyDate))}</span>` : ""}</div></td>
      <td data-label="Due"><div>${escape(group.dueDate)}${group.customer === "automatic" ? `<span class="support">Charge ${escape(timeOn(group.chargeAt, group.dueDate))}</span>` : ""}</div></td>
      <td data-label="Amount" class="amount"><div>${escape(money(amount))}</div></td>
      <td data-label="Stripe status"><div><span class="status ${tone}">${escape(status)}</span>${invoice ? `<span class="support">${escape(`${invoice.attemptCount} Stripe ${invoice.attemptCount === 1 ? "attempt" : "attempts"} · ${money(invoice.amountPaid)} paid`)}</span>` : ""}${note}${evidence ? `<span class="evidence">${evidence}</span>` : ""}</div></td>
    </tr>`;
}

function activity(manifest: Manifest): string {
  if (!manifest.events.length) return "<p>No provider results yet.</p>";
  const names = new Map(
    manifest.groups.map((group) => [group.id, title(group)]),
  );
  return `<ol class="activity">${manifest.events
    .map((event) => {
      const subject = event.groupId
        ? (names.get(event.groupId) ?? event.groupId)
        : event.kind === "advance"
          ? "Test clock"
          : "All invoices";
      return `<li${event.groupId ? "" : ' class="general"'}><time>${escape(instant(event.clockTime))}</time><span class="subject">${escape(subject)}</span><span>${escape(event.message)}</span></li>`;
    })
    .join("")}</ol>`;
}

/** An allowlisted presentation: operation intents and raw provider responses stay private. */
export function renderReport(manifest: Manifest): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing proof</title>
<style>
:root{--muted:#5f6c66;--line:#e3e7e0;--paid:#1d6a4f;--warning:#8a560c;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.5;color:#1c2824;background:#f6f7f4}
*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:0 auto;padding:48px 32px 64px}
h1{font-size:24px;font-weight:600;line-height:1.25;margin:0}h2{font-size:15px;font-weight:600;margin:40px 0 12px}p{margin:0}
.lede{color:var(--muted);margin-top:4px}.preview{color:var(--warning);margin-top:12px}
.context{display:flex;flex-wrap:wrap;gap:8px 40px;margin:24px 0 0}.context div{min-width:0}dd{margin:0;font-variant-numeric:tabular-nums}
dt,thead th,.support,.note,.evidence,ul,time,footer{font-size:13px}dt,thead th,.support,.evidence,ul li span,time,footer{color:var(--muted)}
.support,.note,.evidence{display:block;font-weight:400}.note{margin-top:6px}.evidence{margin-top:8px}
a{color:var(--paid);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--paid);outline-offset:3px;border-radius:2px}
.panel{background:#fff;border:1px solid var(--line);border-radius:8px;overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}
th,td{padding:16px 20px;vertical-align:top;border-top:1px solid var(--line)}th{font-weight:600}
thead th{border-top:0;padding-block:12px;font-weight:400;white-space:nowrap}
tbody th{min-width:220px}td[data-label="Ready"],td[data-label="Due"]{white-space:nowrap}.amount,thead th:nth-child(4){text-align:right;white-space:nowrap}
td[data-label="Stripe status"]{min-width:260px;max-width:340px}
ul{list-style:none;margin:6px 0 0;padding:0;font-weight:400}ul li span{margin-left:6px;white-space:nowrap}
.status{font-weight:600}.paid{color:var(--paid)}.warning{color:var(--warning)}
.activity{list-style:none;margin:0;padding:0}.activity li{display:grid;grid-template-columns:120px 180px 1fr;gap:16px;padding:10px 0;border-top:1px solid var(--line);font-size:15px}
.activity li:first-child{border-top:0}.activity time{padding-top:2px;font-variant-numeric:tabular-nums}.subject{font-weight:600}.general,.general .subject{color:var(--muted);font-weight:400}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);max-width:72ch}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(max-width:760px){main{padding:28px 16px 48px}.context{gap:8px 24px}thead{display:none}table,tbody,tr,th,td{display:block}.panel{overflow:visible}
tbody tr{padding:16px;border-top:1px solid var(--line)}tbody tr:first-child{border-top:0}th,td{border:0;padding:0}tbody th{margin-bottom:12px}
tbody td{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:4px 0;max-width:none!important;min-width:0!important;white-space:normal!important;text-align:left!important}
tbody td::before{content:attr(data-label);font-size:13px;color:var(--muted);padding-top:1px}
.activity li{grid-template-columns:1fr;gap:0}}
</style></head><body><main>
<h1>Billing proof</h1><p class="lede">Stripe sandbox · Synthetic customers · No real charges</p>${manifest.clock.id ? "" : '<p class="preview">Preview only. Stripe validation has not started.</p>'}
<dl class="context"><div><dt>Test clock</dt><dd>${manifest.clock.id ? escape(instant(manifest.clock.frozenTime)) : "Not created"}</dd></div><div><dt>Clock status</dt><dd>${escape(sentence(manifest.clock.status ?? "Not created"))}</dd></div><div><dt>Report generated</dt><dd>${escape(instant(Math.floor(Date.now() / 1000)))}</dd></div></dl>
<h2>Invoices</h2><div class="panel"><table><thead><tr><th scope="col">Invoice and services</th><th scope="col">Ready</th><th scope="col">Due</th><th scope="col">Amount</th><th scope="col">Stripe status</th></tr></thead><tbody>${manifest.groups.map(row).join("")}</tbody></table></div>
<h2>Activity</h2>${activity(manifest)}
<footer>Read-only report; it updates after an operator runs a step. Times use UTC. Ready, due, charge, finalized and activity times follow the Stripe test clock. Invoice links open the current test payment page. Emails and automatic retries are out of scope. No production schedule is configured.</footer>
</main></body></html>`;
}

async function serve(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !["--run-dir", "--host", "--port"].includes(key) ||
      !value ||
      options.has(key)
    )
      throw new Error(
        "Usage: billing:serve -- --run-dir ABSOLUTE_PATH [--host ADDRESS] [--port PORT]",
      );
    options.set(key, value);
  }
  const directory = options.get("--run-dir");
  if (!directory || !isAbsolute(directory))
    throw new Error("Supply an absolute private run directory.");
  const root = await realpath(directory);
  const file = join(root, "report.html");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Expected a generated report.html file.");
  const port = Number(options.get("--port") ?? "4402");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port.");
  const server = Bun.serve({
    hostname: options.get("--host") ?? "127.0.0.1",
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      if (path !== "/" && path !== "/report.html")
        return new Response("Not found", { status: 404 });
      try {
        const current = await lstat(file);
        if (!current.isFile() || current.isSymbolicLink())
          return new Response("Report unavailable", { status: 503 });
        return new Response(
          request.method === "HEAD" ? null : await Bun.file(file).text(),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          },
        );
      } catch {
        return new Response("Report unavailable", { status: 503 });
      }
    },
  });
  console.log(`Read-only billing proof: ${server.url}`);
}

if (import.meta.main) {
  await serve().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Could not serve report.",
    );
    process.exitCode = 1;
  });
}
