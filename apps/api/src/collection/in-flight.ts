import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Bounds decoded request bodies by process and project.
 * Before the handler starts, response, abort, or connection close releases the slot.
 * After it starts, only handler completion releases it, even if the client disconnects,
 * so retries cannot accumulate bodies while inserts wait. Fastify fires neither
 * onResponse nor onRequestAbort for a disconnect after the whole body arrives.
 */
export class InFlight {
  /** Null until the project key is resolved. */
  readonly #requests = new Map<FastifyRequest, string | null>();
  /** Only handler completion releases these slots. */
  readonly #working = new WeakSet<FastifyRequest>();
  readonly #ofProject = new Map<string, number>();
  readonly #max: number;
  readonly #maxPerProject: number;

  constructor(max: number, maxPerProject: number) {
    this.#max = max;
    this.#maxPerProject = maxPerProject;
  }

  /** Takes the slot before any await so concurrent requests cannot exceed the limit. */
  take(request: FastifyRequest, reply: FastifyReply): boolean {
    if (this.#requests.size >= this.#max) return false;
    this.#requests.set(request, null);
    reply.raw.once("close", () => {
      this.#releaseIfIdle(request);
    });
    // The close event may already have fired.
    if (reply.raw.destroyed) this.release(request);
    return true;
  }

  takeForProject(request: FastifyRequest, projectId: string): boolean {
    if (!this.#requests.has(request)) return false;
    const taken = this.#ofProject.get(projectId) ?? 0;
    if (taken >= this.#maxPerProject) return false;
    this.#requests.set(request, projectId);
    this.#ofProject.set(projectId, taken + 1);
    return true;
  }

  /** Holds the slot until work settles, including after a client disconnect. */
  async run<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
    this.#working.add(request);
    try {
      return await work();
    } finally {
      this.release(request);
    }
  }

  /** Safe to call more than once. */
  release(request: FastifyRequest): void {
    if (!this.#requests.has(request)) return;
    const projectId = this.#requests.get(request) ?? null;
    this.#requests.delete(request);
    if (projectId === null) return;
    const left = (this.#ofProject.get(projectId) ?? 1) - 1;
    if (left === 0) this.#ofProject.delete(projectId);
    else this.#ofProject.set(projectId, left);
  }

  #releaseIfIdle(request: FastifyRequest): void {
    if (!this.#working.has(request)) this.release(request);
  }

  /** Route hooks for `onResponse` and `onRequestAbort`: before the handler starts. */
  readonly finished = async (request: FastifyRequest): Promise<void> => {
    this.#releaseIfIdle(request);
  };
}
