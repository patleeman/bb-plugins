import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ds4Process } from "./ds4-process.ts";
import { parseExistingDs4Pid, processMatchesCommand } from "./process-recovery.ts";

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    if (!child.kill()) {
      child.removeListener("exit", onExit);
      resolve();
    }
  });
}

test("extracts a conflicting ds4-server PID from process output", () => {
  assert.equal(
    parseExistingDs4Pid("ds4: another ds4 process is already running (pid 74058); refusing to start"),
    74058,
  );
  assert.equal(parseExistingDs4Pid("server is loading"), null);
});

test("does not terminate an externally-owned adopted server", async () => {
  const proc = new Ds4Process();
  proc.adopt(process.pid, { ownership: "external" });

  assert.equal(proc.state, "running");
  assert.equal(proc.isExternal, true);
  await proc.stop(1);
  assert.equal(proc.state, "running");

  proc.detachExternal();
  assert.equal(proc.state, "exited");
  assert.equal(proc.pid, null);
});

test("clears the PID after a managed process exits unexpectedly", async () => {
  const proc = new Ds4Process();
  const exited = new Promise<void>((resolve) => {
    proc.start({
      bin: process.execPath,
      args: ["-e", "process.exit(2)"],
      cwd: process.cwd(),
      onExit: () => resolve(),
    });
  });
  await exited;

  assert.equal(proc.state, "crashed");
  assert.equal(proc.pid, null);
  assert.equal(proc.startedAt, null);
});

test("does not adopt a same-named server from another checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "ds4-process-match-"));
  const firstCheckout = join(root, "first");
  const secondCheckout = join(root, "second");
  mkdirSync(firstCheckout);
  mkdirSync(secondCheckout);
  for (const checkout of [firstCheckout, secondCheckout]) {
    const binary = join(checkout, "ds4-server");
    copyFileSync("/bin/sleep", binary);
    chmodSync(binary, 0o755);
  }

  const child = spawn("ds4-server", ["60"], {
    cwd: firstCheckout,
    env: { ...process.env, PATH: `${firstCheckout}:${process.env.PATH ?? ""}` },
    stdio: "ignore",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    assert.ok(child.pid);
    assert.equal(
      processMatchesCommand(
        child.pid,
        join(firstCheckout, "ds4-server"),
        ["60"],
        firstCheckout,
      ),
      true,
    );
    assert.equal(
      processMatchesCommand(
        child.pid,
        join(secondCheckout, "ds4-server"),
        ["60"],
        secondCheckout,
      ),
      false,
    );

      const relativeArgs = [
        "-e",
        "setInterval(()=>{},60000)",
        "--",
        "--kv-disk-dir",
        "cache",
        "--trace",
        "trace.log",
        "--dir-steering-file",
        "steering.gguf",
      ];
    const relativeChild = spawn(process.execPath, relativeArgs, {
      cwd: firstCheckout,
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        relativeChild.once("spawn", () => resolve());
        relativeChild.once("error", reject);
      });
      assert.ok(relativeChild.pid);
      assert.equal(
        processMatchesCommand(relativeChild.pid, process.execPath, relativeArgs, firstCheckout),
        true,
      );
      assert.equal(
        processMatchesCommand(relativeChild.pid, process.execPath, relativeArgs, secondCheckout),
        false,
      );
    } finally {
      await terminate(relativeChild);
    }
  } finally {
    await terminate(child);
    rmSync(root, { recursive: true, force: true });
  }
});
