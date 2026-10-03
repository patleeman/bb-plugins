import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DotError } from "./dot-client.js";

type Owner = { nonce: string; pid: number; state: "held" | "uncertain" };
export interface DotLease {
  /** Release only after no submission, or confirmed remote completion/interrupt. */
  release(): Promise<void>;
  /** Keep the room unavailable when delivery/completion cannot be established. */
  uncertain(): Promise<void>;
}
export class DotQueue {
  constructor(private readonly root = join(homedir(), ".config/bb-external-agents/dot-queue"), private readonly pollMs = 200) {}
  async acquire(roomId: string, signal: AbortSignal): Promise<DotLease> {
    const directory = join(this.root, createHash("sha256").update(roomId).digest("hex"));
    const ownerPath = join(directory, "owner.json");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const owner: Owner = { nonce: randomUUID(), pid: process.pid, state: "held" };
    while (true) {
      if (signal.aborted) throw new DotError("Queued Dot request cancelled.");
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new DotError("Dot's room queue is unavailable on this host.");
        let existing: Owner | undefined;
        try { existing = JSON.parse(await readFile(ownerPath, "utf8")); } catch { /* An owner may still be writing its record. Never steal its lock. */ }
        if (existing?.state === "uncertain") throw new DotError("Dot's previous turn has an unconfirmed outcome. Verify it in ChatGPT before recovering the room queue.");
        if (existing && Number.isSafeInteger(existing.pid) && existing.pid > 0) {
          try { process.kill(existing.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new DotError("Dot's previous provider process exited. Verify the remote turn before recovering the room queue.");
          }
        }
        try { await delay(this.pollMs, undefined, { signal }); }
        catch { throw new DotError("Queued Dot request cancelled."); }
        continue;
      }
      try { await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" }); }
      catch { await rm(directory, { recursive: true, force: true }); throw new DotError("Could not record Dot queue ownership."); }
      let released = false;
      const owns = async () => {
        if (released) return false;
        try { return JSON.parse(await readFile(ownerPath, "utf8")).nonce === owner.nonce; }
        catch { return false; }
      };
      const lease: DotLease = {
        async release() {
          if (!await owns()) return;
          released = true;
          await rm(directory, { recursive: true, force: true });
        },
        async uncertain() {
          if (!await owns()) return;
          owner.state = "uncertain";
          await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
        },
      };
      if (signal.aborted) { await lease.release(); throw new DotError("Queued Dot request cancelled."); }
      return lease;
    }
  }
}
