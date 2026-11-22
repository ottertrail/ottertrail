import { parseLogRecord, type ServerLogBuffer } from "./buffer.ts";
import { redactRecord } from "./redact.ts";

/** Where pino writes: a stream with `write`, as Fastify's `logger.stream` takes. */
export interface LogStream {
  write(line: string): void;
}

/**
 * The API's log destination (pino's custom destination, through Fastify's
 * `logger.stream`): each line, with secrets masked (redact.ts), goes to
 * `out` (stdout on a server) and, when given, into the Server log's
 * buffer. A line without secrets goes to `out` byte for byte as pino wrote
 * it; the buffer gets the same JSON.
 */
export function serverLogDestination(out: LogStream, buffer?: ServerLogBuffer): LogStream {
  return {
    write(line: string) {
      const record = parseLogRecord(line);
      if (record === null) {
        // pino writes one JSON object per line; anything else passes through.
        out.write(line);
        return;
      }
      const { value, changed } = redactRecord(record);
      out.write(changed ? `${JSON.stringify(value)}\n` : line);
      buffer?.add("api", value);
    },
  };
}
