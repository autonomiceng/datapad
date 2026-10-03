import { expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import { createNoticeSmtp } from "../../src/server/notice-smtp";
import { renderInvoiceNotice } from "../../src/notifications/templates";
import type { NoticeTemplateInput } from "../../src/notifications/types";

const recipient = "billing@example.test";
const message = {
  recipient,
  messageId: "<synthetic-notice@notices.datapad.test>",
  subject: "Invoice ready",
  text: "Sample invoice",
  html: "<p>Sample invoice</p>",
};
const options = {
  smtp: "smtp://127.0.0.1:1025",
  allowRecipient: (value: string) => value === recipient,
};

test("notice SMTP keeps one envelope, safe local configuration and owned lifecycle", async () => {
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 1025,
  });
  const sent = spyOn(transport, "sendMail").mockImplementation(async () => ({
    accepted: [recipient],
    rejected: [],
    rejectedErrors: [],
    envelopeTime: 1,
    messageTime: 1,
    messageSize: 10,
    response: "250 2.0.0 Accepted",
    envelope: { from: "portal@example.test", to: [recipient] },
    messageId: message.messageId,
  }));
  const created = spyOn(nodemailer, "createTransport").mockReturnValue(
    transport,
  );
  const closed = spyOn(transport, "close");
  try {
    expect(() =>
      createNoticeSmtp({ ...options, smtp: "smtp://smtp.example.test:25" }),
    ).toThrow();
    expect(() =>
      createNoticeSmtp({
        ...options,
        smtp: "smtp://127.0.0.1:1025?service=relay",
      }),
    ).toThrow();
    expect(created).not.toHaveBeenCalled();
    const smtp = createNoticeSmtp(options);
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 1025,
        secure: false,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      }),
    );
    expect(await smtp.send(message)).toEqual({ kind: "accepted" });
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: { from: "portal@example.test", to: [recipient] },
        messageId: message.messageId,
        text: message.text,
        html: message.html,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(
      await smtp.send({ ...message, recipient: "foreign@example.test" }),
    ).toEqual({ kind: "definitively_unaccepted", transient: false });
    expect(
      await smtp.send({
        ...message,
        subject: "Invoice\r\nBcc: foreign@example.test",
      }),
    ).toEqual({ kind: "definitively_unaccepted", transient: false });
    smtp.close();
    smtp.close();
    expect(await smtp.send(message)).toEqual({
      kind: "definitively_unaccepted",
      transient: false,
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  } finally {
    sent.mockRestore();
    created.mockRestore();
    closed.mockRestore();
    transport.close();
  }
});

test("notice SMTP retries only proven nonacceptance and holds ambiguous post-DATA failures", async () => {
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 1025,
  });
  const sent = spyOn(transport, "sendMail");
  const created = spyOn(nodemailer, "createTransport").mockReturnValue(
    transport,
  );
  const smtp = createNoticeSmtp(options);
  try {
    sent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("local rejection"), {
        command: "DATA",
        responseCode: 451,
      });
    });
    expect(await smtp.send(message)).toEqual({
      kind: "definitively_unaccepted",
      transient: true,
    });
    sent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("local rejection"), {
        command: "RCPT TO",
        responseCode: 550,
      });
    });
    expect(await smtp.send(message)).toEqual({
      kind: "definitively_unaccepted",
      transient: false,
    });
    sent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("connect refused"), {
        code: "ESOCKET",
        syscall: "connect",
        command: "CONN",
      });
    });
    expect(await smtp.send(message)).toEqual({
      kind: "definitively_unaccepted",
      transient: true,
    });
    // Nodemailer uses CONN even for a timeout while awaiting the final DATA reply.
    sent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Timeout"), {
        code: "ETIMEDOUT",
        command: "CONN",
      });
    });
    expect(await smtp.send(message)).toEqual({ kind: "uncertain" });
    sent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("stream closed"), {
        code: "ESTREAM",
        command: "API",
      });
    });
    expect(await smtp.send(message)).toEqual({ kind: "uncertain" });
    sent.mockImplementationOnce(async () => ({
      accepted: [],
      rejected: [],
      rejectedErrors: [],
      envelopeTime: 1,
      messageTime: 1,
      messageSize: 10,
      response: "250 unexpected recipient",
      messageId: message.messageId,
      envelope: { from: "portal@example.test", to: [] },
    }));
    expect(await smtp.send(message)).toEqual({ kind: "uncertain" });
  } finally {
    smtp.close();
    sent.mockRestore();
    created.mockRestore();
  }
});

test("invoice notice copy preserves local issue dates and truthful payment actions with escaped HTML", () => {
  const input: NoticeTemplateInput = {
    stage: "invoice",
    invoiceId: "20000000-0000-4000-8000-000000000002",
    billToName: 'Sample <studio> & "team"',
    issuedAt: "2026-10-03T01:00:00Z",
    dueDate: "2026-10-10",
    timeZone: "America/Los_Angeles",
    currency: "USD",
    remainingMinor: 2300,
    paymentReason: "before_charge",
    paymentUrl: "https://invoice.stripe.com/i/synthetic?a=1&b=2",
  };
  const first = renderInvoiceNotice(input);
  expect(first.text).toContain("issued on Oct 2, 2026");
  expect(first.text).toContain("$23.00 USD");
  expect(first.text).toContain("Automatic payment is scheduled.");
  expect(first.html).toContain("Sample &lt;studio&gt; &amp; &quot;team&quot;");
  expect(first.html).toContain("?a=1&amp;b=2");
  const before = renderInvoiceNotice({
    ...input,
    stage: "before_due",
    paymentReason: "not_authorized",
  });
  expect(before.subject).toContain("due Oct 10, 2026");
  expect(before.text).toContain(
    "Automatic payment is not authorized for this invoice.",
  );
  const due = renderInvoiceNotice({
    ...input,
    stage: "due",
    paymentReason: "requires_action",
  });
  expect(due.subject).toContain("Invoice reminder: due");
  expect(due.text).not.toContain("due today");
  expect(due.text).toContain("complete the required action");
  const overdue = renderInvoiceNotice({
    ...input,
    stage: "overdue",
    paymentReason: "missed",
  });
  expect(overdue.subject).toContain("overdue");
  expect(overdue.text).toContain("Automatic payment was not attempted.");
});
