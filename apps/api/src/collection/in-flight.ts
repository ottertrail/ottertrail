import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The requests a route works on at once: at most `max` in the process, and
 * of those at most `maxPerProject` for one project.
 *
 * A request's slot is given back exactly once, on whichever comes first:
 * its answer is sent (`onResponse`), it is aborted (`onRequestAbort`), or
 * its connection closes. The last matters: a client that disconnects after
 * sending the whole body, while the route still waits on ClickHouse, fires
 * neither hook in Fastify, and its slot would otherwise never come back.
 */
export class InFlight {
  /** Each request in progress, with its project once its key is found. */
  readonly #requests = new Map<FastifyRequest, string | null>();
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
      this.release(request);
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

  /** Route hooks for `onResponse` and `onRequestAbort`. */
  readonly finished = async (request: FastifyRequest): Promise<void> => {
    this.release(request);
  };
}
