/**
 * The body of an OTLP/HTTP error answer: google.rpc.Status, with the field
 * names and numbers of Google's definition (google/rpc/status.proto),
 * written here without its `details`, which Ottertrail never sends.
 */
export const STATUS_PROTO = `syntax = "proto3";

package google.rpc;

message Status {
  int32 code = 1;
  string message = 2;
}
`;
