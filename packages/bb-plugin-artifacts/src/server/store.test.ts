import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES } from "../shared";
import { bytes, memoryStore } from "../test/db";
import { displayTitle, versionType } from "./store";

const file = (text: string, extra: Record<string, unknown> = {}) => ({
  name: "report.md",
  mime: "text/markdown",
  bytes: bytes(text),
  projectId: "proj_a",
  sourceThreadId: "thr_1",
  sourcePath: "/work/report.md",
  by: "agent" as const,
  ...extra,
});

describe("ArtifactStore", () => {
  it("creates an artifact with its first version", () => {
    const { store } = memoryStore();
    const { artifact, outcome } = store.save(file("# Hi", { title: "Report" }));
    expect(outcome).toBe("created");
    expect(artifact).toMatchObject({ title: "Report", project_id: "proj_a", updated_by: "agent", versions: 1 });
    expect(artifact.id).toMatch(/^art_[0-9a-z]{16}$/);
    expect(artifact.version).toMatchObject({ number: 1, name: "report.md", size: 4 });
    expect(versionType(artifact.version)).toBe("markdown");
    expect(store.bytes(artifact.version.sha256)?.toString()).toBe("# Hi");
  });

  it("adds a version when the same file from the same thread changes", () => {
    const { store } = memoryStore();
    const first = store.save(file("one", { title: "Report" })).artifact;
    const second = store.save(file("two"));
    expect(second.outcome).toBe("versioned");
    expect(second.artifact.id).toBe(first.id);
    expect(second.artifact.title).toBe("Report");
    expect(second.artifact.version.number).toBe(2);
    expect(store.versions(first.id).map((version) => version.number)).toEqual([2, 1]);
  });

  it("skips saving unchanged bytes, but takes a new title", () => {
    const { store } = memoryStore();
    const first = store.save(file("same")).artifact;
    const again = store.save(file("same", { title: "Renamed" }));
    expect(again.outcome).toBe("unchanged");
    expect(again.artifact).toMatchObject({ id: first.id, title: "Renamed", versions: 1 });
  });

  it("keeps the same file from another thread separate", () => {
    const { store } = memoryStore();
    const a = store.save(file("x")).artifact;
    const b = store.save(file("x", { sourceThreadId: "thr_2" })).artifact;
    expect(b.id).not.toBe(a.id);
    expect(store.list({ threadId: "thr_2" }).map((artifact) => artifact.id)).toEqual([b.id]);
  });

  it("adds a version to the artifact named by artifactId", () => {
    const { store } = memoryStore();
    const first = store.save(file("v1", { sourceThreadId: null, sourcePath: null })).artifact;
    const next = store.save(file("v2", { sourcePath: "/elsewhere/report.md", artifactId: first.id }));
    expect(next).toMatchObject({ outcome: "versioned", artifact: { id: first.id, versions: 2 } });
    expect(() => store.save(file("v3", { artifactId: "art_0000000000000000" }))).toThrow(/not found/);
  });

  it("stores identical bytes once, and drops them with the last artifact that used them", () => {
    const { db, store } = memoryStore();
    const a = store.save(file("shared")).artifact;
    const b = store.save(file("shared", { sourcePath: "/work/copy.md" })).artifact;
    const blobs = () => (db.prepare("SELECT COUNT(*) AS n FROM artifact_blobs").get() as { n: number }).n;
    expect(blobs()).toBe(1);
    expect(store.delete(a.id)).toBe(true);
    expect(blobs()).toBe(1);
    store.delete(b.id);
    expect(blobs()).toBe(0);
    expect(store.delete(b.id)).toBe(false);
  });

  it("refuses files over the size cap", () => {
    const { store } = memoryStore();
    expect(() => store.save(file("", { bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }))).toThrow(/at most 25 MB/);
  });

  it("brings an archived artifact back when it gets a new version", () => {
    const { store } = memoryStore();
    const { id } = store.save(file("a")).artifact;
    store.setArchived(id, true);
    expect(store.list().length).toBe(0);
    store.save(file("b"));
    expect(store.get(id)?.archived_at).toBeNull();
  });

  it("brings an archived artifact back when it's saved again unchanged", () => {
    const { store } = memoryStore();
    const { id } = store.save(file("a")).artifact;
    store.setArchived(id, true);
    const again = store.save(file("a"));
    expect(again).toMatchObject({ outcome: "unchanged", restored: true });
    expect(store.list().map((artifact) => artifact.id)).toEqual([id]);
    expect(store.save(file("a")).restored).toBeUndefined();
  });

  it("orders by last change, with distinct revisions within a millisecond", () => {
    let now = 1000;
    const { store } = memoryStore(() => now);
    const a = store.save(file("a")).artifact;
    now = 2000;
    const b = store.save(file("b", { sourcePath: "/work/b.md" })).artifact;
    expect(store.list().map((artifact) => artifact.id)).toEqual([b.id, a.id]);
    now = 2000;
    const again = store.save(file("b2", { sourcePath: "/work/b.md" })).artifact;
    expect(again.updated_at).toBe(2001);
  });

  it("shows the file name when there's no title", () => {
    const { store } = memoryStore();
    const { artifact } = store.save(file("a"));
    expect(displayTitle(artifact)).toBe("report.md");
  });
});
