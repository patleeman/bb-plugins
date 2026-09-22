import { profileInput, type ProfileInput } from "./contract";

export type ProfileDraft = {
  draft: ProfileInput;
  baseline: ProfileInput;
  mission: string;
  version: number | null;
};
export type DocumentDraft = {
  text: string;
  doc: { text: string; version: string };
};
export function readConfigDraft<T>(
  key: string,
  validate: (value: unknown) => T,
): T | null {
  try {
    return validate(JSON.parse(localStorage.getItem(key) || "null"));
  } catch {
    return null;
  }
}
export function profileDraft(value: unknown): ProfileDraft {
  const v = value as ProfileDraft;
  if (
    !v ||
    typeof v.mission !== "string" ||
    !(v.version === null || typeof v.version === "number")
  )
    throw new Error("Invalid draft");
  return {
    ...v,
    draft: profileInput.parse(v.draft),
    baseline: profileInput.parse(v.baseline),
  };
}
export function documentDraft(value: unknown): DocumentDraft {
  const v = value as DocumentDraft;
  if (
    !v ||
    typeof v.text !== "string" ||
    typeof v.doc?.text !== "string" ||
    typeof v.doc?.version !== "string"
  )
    throw new Error("Invalid draft");
  return v;
}
export function writeConfigDraft(key: string, value: unknown | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
