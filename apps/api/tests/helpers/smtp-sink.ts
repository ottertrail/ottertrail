import { Buffer } from "node:buffer";

import { SMTPServer, type SMTPServerOptions } from "smtp-server";

import { makeCertificate, type TestCertificate } from "./certificate.ts";

/**
 * A local SMTP server for the email tests, on 127.0.0.1 and a port of its
 * own: it keeps every message it accepts. With `login`, it offers
 * STARTTLS with a certificate made at run time and requires a user name
 * and password after it, as a real provider does; without, it offers
 * neither, and takes mail from anyone, as a local relay may. `reject` makes it refuse the next messages with a code.
 */
export interface SmtpSink {
  port: number;
  certificate: TestCertificate;
  messages: { from: string; to: string[]; raw: string }[];
  /** The user names that signed in, and those refused. */
  logins: { user: string; ok: boolean }[];
  /** How many messages to refuse next, and with what code (451: try again later). */
  reject: { count: number; code: number };
  close(): Promise<void>;
}

export async function startSmtpSink({
  login,
}: { login?: { user: string; pass: string } } = {}): Promise<SmtpSink> {
  const certificate = makeCertificate({ names: ["localhost"], addresses: ["127.0.0.1"] });
  const sink: Omit<SmtpSink, "port" | "close"> = {
    certificate,
    messages: [],
    logins: [],
    reject: { count: 0, code: 451 },
  };
  const options: SMTPServerOptions = {
    logger: false,
    key: certificate.privateKey,
    cert: certificate.cert,
    ...(login === undefined
      ? { authOptional: true, disabledCommands: ["AUTH", "STARTTLS"] }
      : {
          authOptional: false,
          onAuth(auth, _session, callback) {
            const ok = auth.username === login.user && auth.password === login.pass;
            sink.logins.push({ user: auth.username ?? "", ok });
            if (ok) {
              callback(null, { user: auth.username });
            } else {
              callback(
                Object.assign(new Error("Invalid user name or password"), { responseCode: 535 }),
              );
            }
          },
        }),
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (sink.reject.count > 0) {
          sink.reject.count -= 1;
          callback(Object.assign(new Error("Try again later"), { responseCode: sink.reject.code }));
          return;
        }
        const from = session.envelope.mailFrom === false ? "" : session.envelope.mailFrom.address;
        sink.messages.push({
          from,
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback();
      });
    },
  };
  const server = new SMTPServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    ...sink,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A message's text with quoted-printable soft breaks and escapes undone, as a mail client shows it. */
export function decodedBody(raw: string): string {
  const [, body] = splitOnce(raw);
  return body
    .replace(/=\r?\n/gu, "")
    .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function splitOnce(raw: string): [string, string] {
  const match = /\r?\n\r?\n/u.exec(raw);
  return match === null
    ? [raw, ""]
    : [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

/** A header's value, unfolded. */
export function header(raw: string, name: string): string | undefined {
  const [head] = splitOnce(raw);
  const unfolded = head.replace(/\r?\n[ \t]+/gu, " ");
  const line = unfolded
    .split(/\r?\n/u)
    .find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}
