import { createTransport } from "nodemailer";

import type { EmailConfig } from "../config.ts";
import { codeOf } from "../outbound/request.ts";
import type { AttemptOutcome } from "./deliveries.ts";
import type { NotificationPayload } from "./events.ts";

/**
 * Alert email over SMTP (docs/uptime-alerts.md, "Where alerts go"), sent
 * with Nodemailer through the server SMTP_URL names, from EMAIL_FROM.
 * Messages are plain text: what happened, when, and the dashboard link;
 * the subject starts with the instance's name. Without SMTP_URL, email
 * deliveries fail at once, saying email is not set up.
 */

/** How long one message may take, from connecting to the server's last answer. */
export const EMAIL_TIMEOUT_MS = 20_000;

export const MAX_SUBJECT = 200;

export const NOT_SET_UP_ERROR =
  "Email isn't set up. Ask the instance's operator to set SMTP_URL and EMAIL_FROM.";

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  /** An HTML version of `text`, escaped (account email); plain text only when left out. */
  html?: string;
}

export interface Mailer {
  send(message: MailMessage, signal: AbortSignal): Promise<{ accepted: number }>;
  close(): void;
}

/**
 * Require STARTTLS for smtp:// credentials to protect the password; smtps:// starts with TLS.
 * Default ports are 587 and 465 respectively. Tests may supply `ca`.
 */
export function smtpMailer(config: EmailConfig, { ca }: { ca?: string } = {}): Mailer {
  // Pass explicit options; URL query options could override them in Nodemailer.
  const url = new URL(config.smtpUrl);
  const secure = url.protocol === "smtps:";
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const password = url.password === "" ? "" : decodeURIComponent(url.password);
  const transport = createTransport(
    {
      host,
      port: url.port === "" ? (secure ? 465 : 587) : Number(url.port),
      secure,
      ...(url.username === ""
        ? {}
        : { auth: { user: decodeURIComponent(url.username), pass: password } }),
      requireTLS: !secure && url.username !== "",
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: EMAIL_TIMEOUT_MS,
      dnsTimeout: 5_000,
      // Disable transport logs because they contain the password.
      logger: false,
      debug: false,
      ...(ca === undefined ? {} : { tls: { ca } }),
    },
    { from: config.from },
  );
  return {
    async send(message, signal) {
      const info = await transport.sendMail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        signal,
      });
      return { accepted: Array.isArray(info.accepted) ? info.accepted.length : 0 };
    },
    close: () => transport.close(),
  };
}

/** A time as the message shows it, in the instance's timezone: "18 Nov 2026, 14:05 (Asia/Singapore)". */
function timeText(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${text} (${timeZone})`;
}

// eslint-disable-next-line no-control-regex -- control characters are what it replaces
export const oneLine = (text: string) => text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();

export function emailOf(
  payload: NotificationPayload,
  instance: { name: string; timeZone: string },
): Omit<MailMessage, "to"> {
  const line = oneLine(`${instance.name}: ${payload.message}`);
  const subject = line.length <= MAX_SUBJECT ? line : `${line.slice(0, MAX_SUBJECT - 1)}…`;
  const text = [
    payload.message,
    "",
    `When: ${timeText(payload.time, instance.timeZone)}`,
    ...(payload.project === null ? [] : [`Project: ${oneLine(payload.project.name)}`]),
    `Open in Ottertrail: ${payload.url}`,
    "",
    `-- `,
    `Sent by "${oneLine(instance.name)}" on Ottertrail.`,
    "",
  ].join("\n");
  return { subject, text };
}

/** Never include SMTP_URL in errors shown to users. */
export function mailError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) {
    return `The SMTP server did not finish within ${EMAIL_TIMEOUT_MS / 1000} seconds.`;
  }
  const code = codeOf(error);
  const record = typeof error === "object" && error !== null ? error : {};
  const status =
    "responseCode" in record && typeof record.responseCode === "number"
      ? ` (${record.responseCode})`
      : "";
  const said =
    "response" in record && typeof record.response === "string"
      ? `: ${oneLine(record.response).slice(0, 200)}`
      : "";
  switch (code) {
    case "EAUTH":
    case "ENOAUTH":
      return `The SMTP server refused the user name and password${status}.`;
    case "EDNS":
      return "The SMTP server's host could not be resolved.";
    case "ECONNECTION":
    case "ESOCKET":
      return "The connection to the SMTP server failed, or the server closed it.";
    case "ETIMEDOUT":
      return "The SMTP server did not answer in time.";
    case "ETLS":
      return "TLS with the SMTP server failed. The server may not support STARTTLS, or its certificate may not be trusted.";
    case "EENVELOPE":
      return `The SMTP server refused the recipients${status}${said}`;
    default:
      return `The SMTP server refused the message${status}${said}`;
  }
}

/** Sends one delivery as email; never throws. Without a mailer, fails for good. */
export async function sendEmail(
  mailer: Mailer | null,
  to: readonly string[],
  payload: NotificationPayload,
  instance: { name: string; timeZone: string },
): Promise<AttemptOutcome> {
  if (mailer === null) return { ok: false, error: NOT_SET_UP_ERROR, final: true };
  const signal = AbortSignal.timeout(EMAIL_TIMEOUT_MS);
  try {
    const { accepted } = await mailer.send({ to: [...to], ...emailOf(payload, instance) }, signal);
    return accepted > 0
      ? { ok: true }
      : { ok: false, error: "The SMTP server accepted none of the addresses." };
  } catch (error) {
    return { ok: false, error: mailError(error, signal) };
  }
}
