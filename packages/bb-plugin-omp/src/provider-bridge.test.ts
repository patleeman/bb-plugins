import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  execOmp,
  experimental_providerBridge,
  loadOmpModels,
  mapOmpModels,
  validateOwnedSessionPath,
} from "./provider-bridge.js";
import {
  OMP_BRIDGE_ARGS_ENV,
  OMP_BRIDGE_COMMAND_ENV,
  resolveOmpLaunch,
} from "./omp-rpc-child.js";

describe("OMP catalog bridge", () => {
  it("honors a PATH-resolved executable override for RPC sessions", () => {
    expect(resolveOmpLaunch({ BB_OMP_BRIDGE_COMMAND: "omp-work", HOME: "/tmp" })).toMatchObject({
      command: "omp-work",
      args: [],
    });
  });

  it("uses the explicit executable for the live model catalog", async () => {
    const root = mkdtempSync(join("/tmp", "bb-omp-catalog-test-"));
    const previousCommand = process.env[OMP_BRIDGE_COMMAND_ENV];
    const previousArgs = process.env[OMP_BRIDGE_ARGS_ENV];
    const catalogScript = "process.stdout.write(JSON.stringify({models:[{provider:'override',id:'only-model',name:'Override only',reasoning:false}]}))";
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      process.env[OMP_BRIDGE_COMMAND_ENV] = process.execPath;
      process.env[OMP_BRIDGE_ARGS_ENV] = JSON.stringify(["-e", catalogScript]);
      const models = await loadOmpModels(workspace);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: "override/only-model",
        routeProviderId: "override",
      });
    } finally {
      if (previousCommand === undefined) delete process.env[OMP_BRIDGE_COMMAND_ENV];
      else process.env[OMP_BRIDGE_COMMAND_ENV] = previousCommand;
      if (previousArgs === undefined) delete process.env[OMP_BRIDGE_ARGS_ENV];
      else process.env[OMP_BRIDGE_ARGS_ENV] = previousArgs;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes OMP's persistent catalog before listing models", async () => {
    const root = mkdtempSync(join("/tmp", "bb-omp-refresh-test-"));
    const previousCommand = process.env[OMP_BRIDGE_COMMAND_ENV];
    const previousArgs = process.env[OMP_BRIDGE_ARGS_ENV];
    const log = join(root, "calls.log");
    const catalogScript = [
      "const fs=require('node:fs');",
      "const args=process.argv.slice(1);",
      "const log=args.shift();",
      "if(args.includes('refresh')){fs.appendFileSync(log,'refresh\\n');process.stdout.write('ok');}",
      "else{fs.appendFileSync(log,'list\\n');if(!fs.readFileSync(log,'utf8').startsWith('refresh\\n'))process.exit(2);process.stdout.write(JSON.stringify({models:[{provider:'lm-studio',id:'qwen/qwen3.6-35b-a3b',name:'Qwen3.6',reasoning:true,thinking:['low','high']}]}));}",
    ].join("");
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      process.env[OMP_BRIDGE_COMMAND_ENV] = process.execPath;
      process.env[OMP_BRIDGE_ARGS_ENV] = JSON.stringify(["-e", catalogScript, log]);
      const models = await loadOmpModels(workspace);
      expect(models[0]).toMatchObject({
        id: "lm-studio/qwen/qwen3.6-35b-a3b",
        routeProviderId: "lm-studio",
      });
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["refresh", "list"]);
    } finally {
      if (previousCommand === undefined) delete process.env[OMP_BRIDGE_COMMAND_ENV];
      else process.env[OMP_BRIDGE_COMMAND_ENV] = previousCommand;
      if (previousArgs === undefined) delete process.env[OMP_BRIDGE_ARGS_ENV];
      else process.env[OMP_BRIDGE_ARGS_ENV] = previousArgs;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reads the catalog when OMP refresh fails", async () => {
    const root = mkdtempSync(join("/tmp", "bb-omp-refresh-fallback-test-"));
    const previousCommand = process.env[OMP_BRIDGE_COMMAND_ENV];
    const previousArgs = process.env[OMP_BRIDGE_ARGS_ENV];
    const catalogScript = [
      "const args=process.argv.slice(1);",
      "if(args.includes('refresh')){process.stderr.write('refresh unavailable');process.exit(1);}",
      "process.stdout.write(JSON.stringify({models:[{provider:'fallback',id:'still-visible',name:'Still visible',reasoning:false}]}));",
    ].join("");
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      process.env[OMP_BRIDGE_COMMAND_ENV] = process.execPath;
      process.env[OMP_BRIDGE_ARGS_ENV] = JSON.stringify(["-e", catalogScript]);
      const models = await loadOmpModels(workspace);
      expect(models[0]).toMatchObject({ id: "fallback/still-visible" });
    } finally {
      if (previousCommand === undefined) delete process.env[OMP_BRIDGE_COMMAND_ENV];
      else process.env[OMP_BRIDGE_COMMAND_ENV] = previousCommand;
      if (previousArgs === undefined) delete process.env[OMP_BRIDGE_ARGS_ENV];
      else process.env[OMP_BRIDGE_ARGS_ENV] = previousArgs;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes stdin for non-interactive commands", async () => {
    const output = await execOmp(process.execPath, [
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ models: [] })))",
      "models",
      "--json",
    ]);

    expect(JSON.parse(output)).toEqual({ models: [] });
  });

  it("maps OMP thinking names to BB reasoning levels", () => {
    const models = mapOmpModels({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5",
          name: "GPT-5",
          reasoning: true,
          thinking: ["minimal", "low", "medium", "high", "xhigh"],
        },
        {
          provider: "plain",
          id: "chat",
          name: "Chat",
          reasoning: false,
        },
      ],
    });

    expect(models[0]).toMatchObject({
      id: "openai-codex/gpt-5",
      routeProviderId: "openai-codex",
      isDefault: true,
      defaultReasoningEffort: "medium",
    });
    expect(models[0]?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(models[1]?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["none"]);
  });

  it("keeps reasoning metadata distinct for OMP routes with the same model family", () => {
    const models = mapOmpModels({
      models: [
        {
          provider: "opencode-go",
          id: "glm-5.3-flash",
          name: "glm-5.3-flash",
          reasoning: false,
          thinking: null,
        },
        {
          provider: "openrouter",
          id: "z-ai/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          reasoning: true,
          thinking: ["minimal", "low", "medium", "high"],
        },
      ],
    });

    expect(models[0]?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["none"]);
    expect(models[1]).toMatchObject({
      id: "openrouter/z-ai/glm-5.3-flash",
      routeProviderId: "openrouter",
      defaultReasoningEffort: "medium",
    });
    expect(models[1]?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["none", "low", "medium", "high"]);
  });

  it("rejects resume and discard paths outside the bridge-owned session root", () => {
    const root = mkdtempSync(join("/tmp", "bb-omp-path-test-"));
    const outside = mkdtempSync(join("/tmp", "bb-omp-outside-test-"));
    try {
      experimental_providerBridge.start?.({
        pluginId: "bb-plugin-omp-test",
        dataDir: root,
        tempDir: join(root, "tmp"),
      });
      const sessions = join(root, "sessions");
      mkdirSync(sessions, { recursive: true });
      const owned = join(sessions, "owned.jsonl");
      writeFileSync(owned, "owned\n");
      expect(validateOwnedSessionPath(owned)).toBe(owned);
      expect(() => validateOwnedSessionPath(join(outside, "secret.jsonl")))
        .toThrow(/outside the bridge session directory/);

      const link = join(sessions, "link.jsonl");
      symlinkSync(join(outside, "secret.jsonl"), link);
      expect(() => validateOwnedSessionPath(link)).toThrow(/symlinks are not allowed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
