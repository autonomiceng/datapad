import nodemailer from "nodemailer";
import type { NoticeSmtp } from "../notifications/types";

const sender = "portal@example.test";
type Outcome = Awaited<ReturnType<NoticeSmtp["send"]>>;

function classify(error: unknown): Outcome {
  if (!error || typeof error !== "object") return { kind: "uncertain" };
  const command = "command" in error ? error.command : null;
  const code = "code" in error ? error.code : null;
  const responseCode = "responseCode" in error ? error.responseCode : null;
  // CONN also labels timeouts and disconnects after DATA in Nodemailer.
  // A command-specific negative reply establishes rejection; a generic close does not.
  if (
    typeof command === "string" &&
    /^(?:MAIL FROM|RCPT TO|DATA|EHLO|HELO)$/.test(command) &&
    typeof responseCode === "number" &&
    Number.isInteger(responseCode) &&
    responseCode >= 400 &&
    responseCode <= 599
  )
    return { kind: "definitively_unaccepted", transient: responseCode < 500 };
  if (
    command === "CONN" &&
    (code === "EDNS" || ("syscall" in error && error.syscall === "connect"))
  )
    return { kind: "definitively_unaccepted", transient: true };
  return { kind: "uncertain" };
}

/** Creates a local Mailpit-only sender with fixed envelope and bounded timeouts; ambiguous failures never authorize retries. Caller owns close(). */
export function createNoticeSmtp(options: {
  smtp: string;
  allowRecipient: (recipient: string) => boolean;
}): NoticeSmtp & {
  /** Releases the owned transporter; subsequent sends are definitively unaccepted. */
  close(): void;
} {
  const url = new URL(options.smtp);
  const port = Number(url.port);
  if (
    url.protocol !== "smtp:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash
  )
    throw new Error("Invoice notices require an explicit loopback SMTP sink.");
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    transactionLog: false,
  });
  let closed = false;
  return {
    async send(message) {
      if (
        closed ||
        !options.allowRecipient(message.recipient) ||
        !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(message.recipient) ||
        message.recipient.length > 254 ||
        message.subject.length < 1 ||
        message.subject.length > 200 ||
        /[\r\n\0]/.test(message.subject) ||
        !/^<[^\s<>@]+@[^\s<>@]+>$/.test(message.messageId) ||
        message.messageId.length > 254
      )
        return { kind: "definitively_unaccepted", transient: false };
      try {
        const result = await transport.sendMail({
          from: { name: "Datapad sample", address: sender },
          to: { address: message.recipient, name: "" },
          envelope: { from: sender, to: [message.recipient] },
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: message.messageId,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return result.accepted.length === 1 &&
          result.accepted[0] === message.recipient &&
          result.rejected.length === 0 &&
          /^250(?:[ -]|$)/.test(result.response)
          ? { kind: "accepted" }
          : { kind: "uncertain" };
      } catch (error) {
        return classify(error);
      }
    },
    close() {
      if (!closed) {
        closed = true;
        transport.close();
      }
    },
  };
}
