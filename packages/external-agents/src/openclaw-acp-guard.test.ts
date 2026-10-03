import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openclawAcpGuard } from "./openclaw-acp-guard.js";

it("fails empty/error ACP completions while preserving answers, cancellation, and upstream error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-acp-guard-test-"));
  try {
    await writeFile(join(root, "guard.mjs"), openclawAcpGuard);
    await writeFile(join(root, "openclaw"), `#!${process.execPath}
const readline = require('node:readline');
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line), sessionId=f.params.sessionId;
 if(['answer','error'].includes(sessionId))send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}});
 if(sessionId==='error')send({method:'session/update',params:{sessionId,update:{sessionUpdate:'error',error:{message:'401 Unauthorized: missing upstream authentication'}}}});
 send({jsonrpc:'2.0',id:f.id,result:{stopReason:sessionId==='cancel'?'cancelled':sessionId==='stop'?'refusal':'end_turn'}});
});`, { mode: 0o700 });
    const child = spawn(process.execPath, [join(root, "guard.mjs"), "acp"], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => output += data);
    const finished = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`guard exited ${code}`))); });
    for (const sessionId of ["empty", "error", "stop", "answer", "cancel"]) child.stdin.write(JSON.stringify({ id: sessionId, method: "session/prompt", params: { sessionId } }) + "\n");
    child.stdin.end(); await finished;
    const replies = output.trim().split("\n").map(line => JSON.parse(line)).filter(frame => frame.id);
    expect(replies.find(f => f.id === "empty").error.message).toContain("without assistant output");
    expect(replies.find(f => f.id === "error").error.message).toBe("401 Unauthorized: missing upstream authentication");
    expect(replies.find(f => f.id === "stop").error.message).toBe("OpenClaw stopped: refusal");
    expect(replies.find(f => f.id === "answer").result.stopReason).toBe("end_turn");
    expect(replies.find(f => f.id === "cancel").result.stopReason).toBe("cancelled");
  } finally { await rm(root, { recursive: true, force: true }); }
});
