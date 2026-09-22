// Only passive raster formats are embedded. MIME labels and file extensions are
// untrusted; SVG/HTML and unknown data remain downloadable files.
export function imageMime(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) =>
    prefix.every((b, i) => bytes[i] === b);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.slice(from, to));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
export const inlineImage = (a: { type: string; mimeType?: string }) =>
  a.type === "localImage" &&
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    a.mimeType ?? "",
  );
