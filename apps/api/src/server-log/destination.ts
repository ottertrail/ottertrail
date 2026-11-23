import { parseLogRecord, type ServerLogBuffer } from "./buffer.ts";
import { redactRecord } from "./redact.ts";

export interface LogStream {
  write(line: string): void;
}

/**
 * Mask secrets before writing to stdout and the buffer (redact.ts).
 * Preserve pino's bytes when no redaction is needed.
 */
export function serverLogDestination(out: LogStream, buffer?: ServerLogBuffer): LogStream {
  return {
    write(line: string) {
      const record = parseLogRecord(line);
      if (record === null) {
        out.write(line);
        return;
      }
      const { value, changed } = redactRecord(record);
      out.write(changed ? `${JSON.stringify(value)}\n` : line);
      buffer?.add("api", value);
    },
  };
}
