import { hostname } from "node:os";

/**
 * The identity of the station this process runs on.
 *
 * Worktree leases and the Postgres catalog mirror both need to answer "which
 * machine claimed this", and they have to answer it the same way — a lease
 * written under `spark01` and a sync row written under `HASNA_MACHINE_ID` would
 * describe the same station under two names and make every cross-machine
 * reconciliation wrong.
 */
export function getSourceMachineId(): string {
  return (
    process.env["HASNA_MACHINE_ID"]
    || process.env["OPEN_MACHINES_ID"]
    || process.env["MACHINE_ID"]
    || hostname()
  );
}
