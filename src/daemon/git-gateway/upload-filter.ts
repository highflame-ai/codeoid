/**
 * What an agent's git asks upload-pack, read on the way (docs/git-gateway-design.md §3.3). The cache may hold objects
 * no ref reaches (the remote deleted them; codeoid prunes them, but a request can come first), and upload-pack answers
 * a `shallow <id>` line (it serves that commit's history), a `have <id>` (it acknowledges it) or a `deepen-not <rev>`
 * for any object it holds. So only protocol v0's own lines pass, an id the remote's refs don't reach is dropped from a
 * `shallow` or `have` line (as if the object weren't there, which is what upload-pack does for one it lacks), a
 * `deepen-not` names an advertised branch or tag, and a filter is one that names no object. Anything else ends the
 * request.
 */

/** Which of `ids` the cache's refs reach (the rest is as good as absent). */
export type ReachJudge = (ids: readonly string[]) => Promise<Set<string>>;

const ID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const WANT = new RegExp(`^want ${ID}(?: [\\x21-\\x7e ]*)?$`);
const SHALLOW = new RegExp(`^shallow (${ID})$`);
const HAVE = new RegExp(`^have (${ID})$`);
const DEEPEN = /^deepen [1-9][0-9]{0,9}$/;
const DEEPEN_SINCE = /^deepen-since [0-9]{1,12}$/;
const DEEPEN_NOT = /^deepen-not (refs\/(?:heads|tags)\/[\x21-\x7e]+)$/;
// Filters that name no object (a `sparse:oid` reads a blob as patterns; `combine` is refused for simplicity).
const FILTER = /^filter (?:blob:none|blob:limit=[0-9]{1,12}[kmg]?|tree:[0-9]{1,6})$/;

/**
 * A stream filter: `push` the client's bytes as they come; what may reach upload-pack is handed to `out`, in order;
 * `fail` ends the request. `end` runs after everything pushed is handled.
 */
export class UploadFilter {
  #buf: Buffer = Buffer.alloc(0);
  #chain: Promise<void> = Promise.resolve();
  #pending: string[] = [];
  #wantsDone = false;
  #done = false;
  #dead = false;

  constructor(
    private readonly judge: ReachJudge,
    private readonly refNames: () => Promise<Set<string>>,
    private readonly out: (b: Buffer) => void,
    private readonly fail: () => void,
  ) {}

  push(chunk: Buffer): void {
    this.#chain = this.#chain.then(() => this.#take(chunk)).catch(() => this.#die());
  }

  end(then: () => void): void {
    this.#chain = this.#chain.then(
      () => {
        if (!this.#dead) then();
      },
      () => this.#die(),
    );
  }

  #die(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.fail();
  }

  async #take(chunk: Buffer): Promise<void> {
    if (this.#dead) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 4) {
      if (this.#dead) return;
      const head = this.#buf.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-f]{4}$/.test(head)) return this.#die();
      const n = Number.parseInt(head, 16);
      if (n === 0) {
        this.#buf = this.#buf.subarray(4);
        await this.#flush();
        continue;
      }
      // No delim or response-end packets in v0, and no line longer than pkt-line's own limit.
      if (n < 5 || n > 65520) return this.#die();
      if (this.#buf.length < n) return;
      const raw = this.#buf.subarray(4, n);
      this.#buf = this.#buf.subarray(n);
      // Lines are text: a NUL only on the first want (its capabilities, which v0 puts after a space; refused here).
      const line = raw.toString("latin1").replace(/\n$/, "");
      if (/[\x00-\x1f\x7f]/.test(line)) return this.#die();
      await this.#line(line);
    }
  }

  async #line(line: string): Promise<void> {
    if (this.#done) return this.#die();
    if (!this.#wantsDone) {
      if (WANT.test(line) || DEEPEN.test(line) || DEEPEN_SINCE.test(line) || FILTER.test(line) || SHALLOW.test(line)) {
        this.#pending.push(line);
        return;
      }
      const not = DEEPEN_NOT.exec(line);
      if (not?.[1] && (await this.refNames()).has(not[1])) {
        this.#pending.push(line);
        return;
      }
      return this.#die();
    }
    if (HAVE.test(line)) {
      this.#pending.push(line);
      return;
    }
    if (line === "done") {
      await this.#release();
      this.#emit("done\n");
      this.#done = true;
      return;
    }
    return this.#die();
  }

  async #flush(): Promise<void> {
    await this.#release();
    if (this.#dead) return;
    this.out(Buffer.from("0000"));
    this.#wantsDone = true;
  }

  /** Hand on the lines held back, without the shallow and have lines naming what no ref reaches. */
  async #release(): Promise<void> {
    const lines = this.#pending;
    this.#pending = [];
    const ids = lines.map((l) => SHALLOW.exec(l)?.[1] ?? HAVE.exec(l)?.[1]).filter((x): x is string => !!x);
    const reached = ids.length > 0 ? await this.judge(ids) : new Set<string>();
    for (const l of lines) {
      const id = SHALLOW.exec(l)?.[1] ?? HAVE.exec(l)?.[1];
      if (id && !reached.has(id)) continue;
      this.#emit(`${l}\n`);
    }
  }

  #emit(payload: string): void {
    const b = Buffer.from(payload, "latin1");
    this.out(Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0"), "latin1"), b]));
  }
}
