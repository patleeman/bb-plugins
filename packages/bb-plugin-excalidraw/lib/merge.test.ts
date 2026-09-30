import { describe, expect, it } from "vitest";
import {
  applyElementUpserts,
  elementsChanged,
  missingFiles,
  serializeSceneData,
  type SceneElement,
} from "./merge";

const rect: SceneElement = {
  id: "r1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  strokeColor: "#1e1e1e",
  version: 3,
  versionNonce: 111,
  index: "a0",
  isDeleted: false,
};

function stored(elements: SceneElement[]): string {
  return serializeSceneData({ elements, appState: {}, files: {} });
}

describe("applyElementUpserts", () => {
  it("merges a partial upsert into the stored element", () => {
    const scene = applyElementUpserts(stored([rect]), [
      { id: "r1", type: "rectangle", x: 40 },
    ]);
    const [el] = scene.elements;
    expect(el).toMatchObject({
      id: "r1",
      x: 40,
      y: 0,
      width: 100,
      height: 50,
      strokeColor: "#1e1e1e",
      index: "a0",
      version: 4,
      isDeleted: false,
    });
    expect(el?.versionNonce).not.toBe(111);
    expect(typeof el?.updated).toBe("number");
  });

  it("bumps the nonce even when the agent echoes the stored one", () => {
    const scene = applyElementUpserts(stored([rect]), [{ ...rect, x: 5 }]);
    expect(scene.elements[0]?.version).toBe(4);
    expect(scene.elements[0]?.versionNonce).not.toBe(111);
  });

  it("adds new elements after the existing ones", () => {
    const scene = applyElementUpserts(stored([rect]), [
      { id: "t1", type: "text", text: "hi" },
    ]);
    expect(scene.elements.map((el) => el.id)).toEqual(["r1", "t1"]);
    expect(scene.elements[1]?.version).toBe(1);
  });
});

describe("elementsChanged", () => {
  it("is false for the same ids, versions and nonces", () => {
    expect(elementsChanged([rect], [{ ...rect }])).toBe(false);
  });

  it("is true for a new version, nonce or element", () => {
    expect(elementsChanged([rect], [{ ...rect, version: 4 }])).toBe(true);
    expect(elementsChanged([rect], [{ ...rect, versionNonce: 2 }])).toBe(true);
    expect(elementsChanged([rect], [rect, { id: "t1", type: "text" }])).toBe(true);
  });
});

describe("missingFiles", () => {
  it("returns only files the editor hasn't loaded", () => {
    const loaded = { f1: { id: "f1" } };
    expect(missingFiles(loaded, { f1: { id: "f1" }, f2: { id: "f2" } })).toEqual([{ id: "f2" }]);
    expect(missingFiles(loaded, undefined)).toEqual([]);
  });
});
