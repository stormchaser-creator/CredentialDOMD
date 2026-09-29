// Whether this module is the script node was started with. The runner copies
// its code into a temp folder (ticket-agent.sh HOST_DIR), and on macOS /tmp
// and $TMPDIR are symlinks into /private. Node gives import.meta.url as the
// real path while process.argv[1] keeps the symlinked one, so comparing them
// as strings said "not main" and every host step exited 0 having done nothing
// (the queue step wrote no queue.json: "malformed ticket queue", 2026-09-29).
// Compare real paths instead.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1); } catch { return false; }
}
