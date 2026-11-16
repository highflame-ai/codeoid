/**
 * What a sandboxed agent's push may change through the git gateway
 * (docs/git-gateway-design.md §3.3): one or more branch updates, each
 * judged before anything reaches the remote. Pure: the caller supplies
 * what it needs to know (the remote's default branch, an ancestry check).
 */

/** One ref update as git's pre-receive hook reads it: `old new ref`. */
export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

export interface PushPolicy {
  /** Branches never pushed to (`sandbox.push.protectedBranches`), case-insensitive; a trailing `*` matches a prefix. */
  protectedBranches: readonly string[];
  /** The remote's default branch, when known (its `HEAD`): never pushed to. */
  defaultBranch: string | null;
}

const ZERO = /^0+$/;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Whether `name` matches `pattern` (case-insensitive; a trailing `*` matches any rest). */
export function branchMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** A branch name shown to the owner as it is: nothing invisible or reordering, no control character. */
export function plainBranchName(name: string): boolean {
  return !/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}\s]/u.test(name) && name.length > 0 && name.length <= 250;
}

/**
 * Why `u` may not go to the remote, or null. `isAncestor(old, new)` answers whether the update is a fast-forward
 * (the pushed objects and the remote's, as the gateway just fetched them, both at hand).
 */
export async function refUpdateProblem(u: RefUpdate, policy: PushPolicy, isAncestor: (old: string, next: string) => Promise<boolean>): Promise<string | null> {
  if (!OID.test(u.old) || !OID.test(u.new)) return `${u.ref}: not an update git sent`;
  if (!u.ref.startsWith("refs/heads/")) return `${u.ref}: only branches are pushed for agents (no tags, notes or other refs)`;
  const branch = u.ref.slice("refs/heads/".length);
  if (!plainBranchName(branch)) return `${JSON.stringify(branch)} isn't a plain branch name`;
  if (ZERO.test(u.new)) return `${branch}: deleting a branch isn't done for agents`;
  if (policy.protectedBranches.some((p) => branchMatches(p, branch))) {
    return `${branch} is a protected branch (sandbox.push.protectedBranches): push your work to a branch of its own, and open a pull request`;
  }
  if (policy.defaultBranch && policy.defaultBranch.toLowerCase() === branch.toLowerCase()) {
    return `${branch} is the remote's default branch: push your work to a branch of its own, and open a pull request`;
  }
  if (!ZERO.test(u.old) && !(await isAncestor(u.old, u.new))) {
    return `${branch}: the remote has commits yours doesn't (a force push isn't done for agents): fetch and rebase or merge, or push to a new branch`;
  }
  return null;
}
