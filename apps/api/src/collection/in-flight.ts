import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The requests a route works on at once: at most `max` in the process, and
 * of those at most `maxPerProject` for one project. It bounds memory: a
 * request holds its body, decoded, until its insert settles.
 *
 * A request's slot is given back exactly once. Before its handler starts
 * (the body still uploading, or refused by a hook), on whichever comes
 * first: its answer is sent (`onResponse`), it is aborted
 * (`onRequestAbort`), or its connection closes. Once the handler has
 * started, only when the handler settles (`run`), whether or not its answer
 * could be sent: a client that disconnects while its insert is held gives
 * its slot back when the insert settles, not before, so a retry cannot
 * stack another body on the one still held. (Fastify fires neither hook
 * for a client that disconnects after sending the whole body.)
 */
export class InFlight {
  /** Each request in progress, with its project once its key is found. */
  readonly #requests = new Map<FastifyRequest, string | null>();
  /** The requests whose handler has started: only it gives their slots back. */
  readonly #working = new WeakSet<FastifyRequest>();
  readonly #ofProject = new Map<string, number>();
  readonly #max: number;
  readonly #maxPerProject: number;

  constructor(max: number, maxPerProject: number) {
    this.#max = max;
    this.#maxPerProject = maxPerProject;
  }

  /**
   * Takes a slot in the process, false when all are taken. Taken before
   * anything waits, so requests arriving together cannot all pass.
   */
  take(request: FastifyRequest, reply: FastifyReply): boolean {
    if (this.#requests.size >= this.#max) return false;
    this.#requests.set(request, null);
    reply.raw.once("close", () => {
      this.#releaseIfIdle(request);
    });
    // Closed already, its close event is past: nobody waits for the answer.
    if (reply.raw.destroyed) this.release(request);
    return true;
  }

  /** Counts the request against its project, false when the project's slots are taken. */
  takeForProject(request: FastifyRequest, projectId: string): boolean {
    if (!this.#requests.has(request)) return false;
    const taken = this.#ofProject.get(projectId) ?? 0;
    if (taken >= this.#maxPerProject) return false;
    this.#requests.set(request, projectId);
    this.#ofProject.set(projectId, taken + 1);
    return true;
  }

  /** Runs a request's handler, its slot given back once the handler settles. */
  async run<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
    this.#working.add(request);
    try {
      return await work();
    } finally {
      this.release(request);
    }
  }

  /** Gives the request's slots back; a second call does nothing. */
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
