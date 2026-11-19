import type { GarageConfig } from "../config.ts";

/**
 * Garage's admin API, version 2, as the stack's Garage v2.5.0 serves it
 * (deploy/compose.yaml). Three calls, each with the admin token as a
 * bearer token:
 *
 * - `GET /v2/GetBucketInfo?globalAlias=<bucket>`: the bucket's `id`,
 *   `objects`, `bytes`, and `quotas` (`maxSize`, `maxObjects`).
 * - `GET /v2/GetClusterStatus`: each node's `dataPartition`, the
 *   `available` and `total` bytes of the filesystem Garage keeps its data
 *   on, which Garage reads with statvfs every 10 seconds.
 * - `POST /v2/UpdateBucket?id=<id>` with `{ "quotas": { "maxSize": …,
 *   "maxObjects": null } }`: the bucket's quota. Fields left out of the
 *   body stay as they are.
 *
 * Docs: https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/
 * and the v2 specification, https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html.
 * The routes are in src/api/admin/router_v2.rs and the bodies in
 * src/api/admin/api.rs at tag v2.5.0
 * (https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/admin/router_v2.rs#L34-L66,
 * https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.5.0/src/api/admin/api.rs#L191-L251,
 * #L924-L1030). Checked against a v2.5.0 container on 19 November 2026.
 *
 * The token is sent only in the Authorization header: no error message,
 * log line, or answer repeats it.
 */

/** How long one admin request may take: the Settings page waits for it. */
export const GARAGE_ADMIN_TIMEOUT_MS = 3000;

export interface GarageBucket {
  id: string;
  objects: number;
  bytes: number;
  /** The bucket's size quota in bytes; null when none is set. */
  maxSize: number | null;
}

export interface GaragePartition {
  availableBytes: number;
  totalBytes: number;
}

export interface GarageAdmin {
  /** The bucket with this global alias; null when Garage has none of that name. */
  bucket(alias: string): Promise<GarageBucket | null>;
  /** The data partition of the first node that reports one; null when none does. */
  dataPartition(): Promise<GaragePartition | null>;
  /** Sets the bucket's size quota; null removes it. Its object count stays unlimited. */
  setQuota(bucketId: string, maxSize: number | null): Promise<void>;
}

/** An admin request that failed, in words that never hold the token. */
export class GarageAdminError extends Error {
  override name = "GarageAdminError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A refused admin request, in words that never hold the token. */
function refused(status: number): GarageAdminError {
  if (status === 401 || status === 403) {
    return new GarageAdminError(
      "Garage refused the admin token. Set the same GARAGE_ADMIN_TOKEN for Garage, the API, and the worker, then run `docker compose up -d`.",
    );
  }
  return new GarageAdminError(`Garage's admin API answered HTTP ${status}.`);
}

export function garageAdmin(
  config: GarageConfig & { adminToken: string },
  { fetch: send = fetch }: { fetch?: typeof fetch } = {},
): GarageAdmin {
  async function call(path: string, init: { method?: string; body?: unknown } = {}) {
    let response: Response;
    try {
      response = await send(`${config.adminUrl}/v2/${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${config.adminToken}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(GARAGE_ADMIN_TIMEOUT_MS),
      });
    } catch (error) {
      // The address stays in the cause, for the server's log only.
      throw new GarageAdminError(
        "Garage's admin API did not answer. Check that Garage is running with its admin API on port 3903.",
        { cause: error },
      );
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  return {
    async bucket(alias) {
      const { status, body } = await call(`GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`);
      if (status === 404) return null;
      if (status !== 200) throw refused(status);
      const quotas = isRecord(body) ? body.quotas : undefined;
      const maxSize = isRecord(quotas) ? quotas.maxSize : undefined;
      if (
        !isRecord(body) ||
        typeof body.id !== "string" ||
        !isCount(body.objects) ||
        !isCount(body.bytes) ||
        !(maxSize === null || isCount(maxSize))
      ) {
        throw new GarageAdminError(
          "Garage's admin API sent an unexpected answer about the bucket.",
        );
      }
      return { id: body.id, objects: body.objects, bytes: body.bytes, maxSize };
    },

    async dataPartition() {
      const { status, body } = await call("GetClusterStatus");
      if (status !== 200) throw refused(status);
      if (!isRecord(body) || !Array.isArray(body.nodes)) {
        throw new GarageAdminError("Garage's admin API sent an unexpected cluster status.");
      }
      for (const node of body.nodes) {
        const partition = isRecord(node) ? node.dataPartition : undefined;
        if (isRecord(partition) && isCount(partition.available) && isCount(partition.total)) {
          return { availableBytes: partition.available, totalBytes: partition.total };
        }
      }
      return null;
    },

    async setQuota(bucketId, maxSize) {
      const { status } = await call(`UpdateBucket?id=${encodeURIComponent(bucketId)}`, {
        method: "POST",
        body: { quotas: { maxSize, maxObjects: null } },
      });
      if (status !== 200) throw refused(status);
    },
  };
}

/** Quotas above the budgets move in steps of this size, so a bucket that changes a little does not change its quota each check. */
export const QUOTA_STEP_BYTES = 256 * 1024 ** 2;

export interface QuotaPlan {
  /** The quota to keep on the bucket. */
  bytes: number;
  /**
   * The bucket already holds more than the budgets leave room for (a
   * budget was lowered below what is stored): the quota sits above the
   * budgets plus 10%, so writes within the budgets still fit.
   */
  aboveBudgets: boolean;
}

/**
 * The bucket quota the worker keeps on the stack's Garage: the replay and
 * source map budgets together, plus 10%, and never less than what the
 * bucket holds plus the room left in both budgets, plus 10%.
 *
 * A backstop: the budgets refuse new replays and uploads first. It matters
 * when the bucket holds more than Ottertrail counts (an object restored
 * from a newer backup, or one a failed write left behind), and keeps such
 * objects from growing past the budgets. Garage refuses a write past it
 * with 403 "Bucket size quota is reached" (src/api/s3/put.rs at v2.5.0).
 * Without the floor, lowering a budget below what is stored would make
 * Garage refuse every write, those within the budgets too, until enough
 * replays expired.
 */
export function plannedQuota(
  budgets: { replayBytes: number; sourceMapBytes: number },
  now: { bucketBytes: number; roomBytes: number } | null = null,
): QuotaPlan {
  const total = budgets.replayBytes + budgets.sourceMapBytes;
  const base = Math.ceil(total * 1.1);
  if (now === null || now.bucketBytes + now.roomBytes <= total) {
    return { bytes: base, aboveBudgets: false };
  }
  const raised =
    Math.ceil(((now.bucketBytes + now.roomBytes) * 1.1) / QUOTA_STEP_BYTES) * QUOTA_STEP_BYTES;
  return raised > base
    ? { bytes: raised, aboveBudgets: true }
    : { bytes: base, aboveBudgets: false };
}

/** The room left in both budgets, from what Ottertrail recorded. */
export function budgetRoom(budgets: {
  replays: { usedBytes: number; limitBytes: number };
  sourceMaps: { usedBytes: number; limitBytes: number };
}): number {
  return (
    Math.max(0, budgets.replays.limitBytes - budgets.replays.usedBytes) +
    Math.max(0, budgets.sourceMaps.limitBytes - budgets.sourceMaps.usedBytes)
  );
}

/**
 * Without GARAGE_ADMIN_TOKEN, Compose still passes the variable to Garage,
 * empty, and Garage's admin API still listens. Garage then refuses every
 * admin request, because no request can carry an empty bearer token
 * (tested on v2.5.0). The worker checks it at start, so that safety does
 * not rest on that alone: an admin request with an empty token, and one
 * with none, must both be refused. "accepted" is logged as an error.
 */
export async function probeOpenAdminApi(
  adminUrl: string,
  { fetch: send = fetch }: { fetch?: typeof fetch } = {},
): Promise<"refused" | "accepted" | "unreachable"> {
  let accepted = false;
  try {
    for (const headers of [{ authorization: "Bearer " }, {}]) {
      const response = await send(`${adminUrl}/v2/GetClusterStatus`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(GARAGE_ADMIN_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) accepted = true;
    }
  } catch {
    return "unreachable";
  }
  return accepted ? "accepted" : "refused";
}
