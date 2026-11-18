import { Buffer } from "node:buffer";
import dgram from "node:dgram";

/**
 * A name server on 127.0.0.1 for the uptime tests, over UDP on a port of
 * its own: it answers A queries for the names in `answers` with their
 * IPv4 address, AAAA queries with no record, and never answers a name in
 * `silent`, as a name server that is down. Anything else is NXDOMAIN.
 */
export interface TestDnsServer {
  /** "127.0.0.1:<port>", for a resolver's setServers(). */
  address: string;
  /** Queries received, as "A fast.test". */
  queries: string[];
  close(): Promise<void>;
}

/** The question's name and where the question ends, from a DNS message. */
function questionOf(message: Buffer): { name: string; end: number; type: number } {
  const labels: string[] = [];
  let at = 12;
  for (let length = message[at] ?? 0; length > 0; length = message[at] ?? 0) {
    labels.push(message.subarray(at + 1, at + 1 + length).toString("ascii"));
    at += length + 1;
  }
  const type = message.readUInt16BE(at + 1);
  return { name: labels.join(".").toLowerCase(), end: at + 5, type };
}

export async function startDnsServer({
  answers = {},
  silent = [],
}: {
  answers?: Record<string, string>;
  silent?: string[];
}): Promise<TestDnsServer> {
  const socket = dgram.createSocket("udp4");
  const queries: string[] = [];
  socket.on("message", (message, remote) => {
    const { name, end, type } = questionOf(message);
    queries.push(`${type === 1 ? "A" : type === 28 ? "AAAA" : String(type)} ${name}`);
    if (silent.includes(name)) return;
    const address = answers[name];
    const answer =
      type === 1 && address !== undefined
        ? Buffer.concat([
            // A pointer to the question's name, type A, class IN, 60 seconds, 4 bytes.
            Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]),
            Buffer.from(address.split(".").map(Number)),
          ])
        : Buffer.alloc(0);
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    // A response, recursion desired and available; NXDOMAIN for a name it does not know.
    header.writeUInt16BE(address === undefined ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answer.length > 0 ? 1 : 0, 6);
    socket.send(
      Buffer.concat([header, message.subarray(12, end), answer]),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    address: `127.0.0.1:${socket.address().port}`,
    queries,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
