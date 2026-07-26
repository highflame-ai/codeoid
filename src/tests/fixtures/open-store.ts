/**
 * Test fixture: open a daemon Store at argv[2], print OK, exit 0.
 *
 * Run as a SUBPROCESS by store-lock.test.ts so two genuinely concurrent
 * processes contend on one fresh database — the shape that reproduced the
 * cold-start crash. In-process opens cannot reproduce it: the WAL journal-mode
 * race and the check-then-act migration race both need separate connections
 * initializing at the same instant.
 *
 * Prints `FAIL: <first line>` and exits 1 on any error, so the test can report
 * the real message instead of a bare exit code.
 */

import { Store } from "../../daemon/store.js";

const path = Bun.argv[2];
if (!path) {
  console.log("FAIL: no database path given");
  process.exit(1);
}

try {
  const store = new Store(path);
  store.close();
  console.log("OK");
} catch (err) {
  console.log(`FAIL: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  process.exit(1);
}
