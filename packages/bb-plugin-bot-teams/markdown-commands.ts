import { EditorSelection, type StateCommand } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export function wrapMarkdown(
  marker: string,
  placeholder: string,
): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const { from, to } = state.selection.main;
    const selected = state.sliceDoc(from, to);
    const leftStars = state.sliceDoc(0, from).match(/\*+$/)?.[0].length ?? 0;
    const rightStars = state.sliceDoc(to).match(/^\*+/)?.[0].length ?? 0;
    const wrapped =
      (marker !== "*" || (leftStars % 2 === 1 && rightStars % 2 === 1)) &&
      from >= marker.length &&
      state.sliceDoc(from - marker.length, from) === marker &&
      state.sliceDoc(to, to + marker.length) === marker;
    const includesMarkers =
      (marker !== "*" ||
        ((selected.match(/^\*+/)?.[0].length ?? 0) % 2 === 1 &&
          (selected.match(/\*+$/)?.[0].length ?? 0) % 2 === 1)) &&
      selected.length >= marker.length * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker);
    const content = includesMarkers
      ? selected.slice(marker.length, -marker.length)
      : wrapped
        ? selected
        : selected || placeholder;
    const start =
      from + (includesMarkers ? 0 : wrapped ? -marker.length : marker.length);
    dispatch(
      state.update({
        changes: includesMarkers
          ? { from, to, insert: content }
          : wrapped
            ? [
                { from: from - marker.length, to: from },
                { from: to, to: to + marker.length },
              ]
            : { from, to, insert: `${marker}${content}${marker}` },
        selection: EditorSelection.range(start, start + content.length),
        userEvent: "input",
        annotations: isolateHistory.of("full"),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export function prefixMarkdown(prefix: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(
      to > from && state.doc.lineAt(to).from === to ? to - 1 : to,
    );
    const lines = Array.from(
      { length: last.number - first.number + 1 },
      (_, i) => state.doc.line(first.number + i),
    );
    const remove = lines.every((line) => line.text.startsWith(prefix));
    const changes = state.changes(
      lines.map((line) =>
        remove
          ? { from: line.from, to: line.from + prefix.length }
          : { from: line.from, insert: prefix },
      ),
    );
    dispatch(
      state.update({
        changes,
        selection: state.selection.map(changes),
        userEvent: "input",
        annotations: isolateHistory.of("full"),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const insertMarkdownLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const { from, to } = state.selection.main;
  const label = state.sliceDoc(from, to) || "link text";
  const url = "https://";
  const start = from + label.length + 3;
  dispatch(
    state.update({
      changes: { from, to, insert: `[${label}](${url})` },
      selection: EditorSelection.range(start, start + url.length),
      userEvent: "input",
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
    }),
  );
  return true;
};
