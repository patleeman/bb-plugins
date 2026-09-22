import assert from "node:assert/strict";
import test from "node:test";
import { EditorState, type StateCommand } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import {
  wrapMarkdown,
  prefixMarkdown,
  insertMarkdownLink,
} from "../markdown-commands";

function editor(doc: string, anchor: number, head = anchor, readOnly = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [history(), EditorState.readOnly.of(readOnly)],
  });
  return {
    get state() {
      return state;
    },
    run(command: StateCommand) {
      return command({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      });
    },
  };
}

test("formatting preserves the selection and is reversible with undo and redo", () => {
  const e = editor("Keep this decision.", 5, 9);
  e.run(wrapMarkdown("**", "bold text"));
  assert.equal(e.state.doc.toString(), "Keep **this** decision.");
  assert.equal(
    e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to),
    "this",
  );
  e.run(undo);
  assert.equal(e.state.doc.toString(), "Keep this decision.");
  e.run(redo);
  assert.equal(e.state.doc.toString(), "Keep **this** decision.");
  e.run(wrapMarkdown("**", "bold text"));
  assert.equal(e.state.doc.toString(), "Keep this decision.");
});

test("undoing formatting never removes text typed immediately before it", () => {
  const e = editor("Keep ", 5);
  e.run(({ state, dispatch }) => {
    dispatch(
      state.update({
        changes: { from: 5, insert: "this" },
        selection: { anchor: 5, head: 9 },
        userEvent: "input.type",
      }),
    );
    return true;
  });
  e.run(wrapMarkdown("**", "bold text"));
  e.run(undo);
  assert.equal(e.state.doc.toString(), "Keep this");
  e.run(undo);
  assert.equal(e.state.doc.toString(), "Keep ");
});

test("empty formatting inserts selected placeholder text and removes empty markers safely", () => {
  const e = editor("", 0);
  e.run(wrapMarkdown("*", "italic text"));
  assert.equal(e.state.doc.toString(), "*italic text*");
  assert.deepEqual(
    [e.state.selection.main.from, e.state.selection.main.to],
    [1, 12],
  );
  const empty = editor("****", 2);
  empty.run(wrapMarkdown("**", "bold text"));
  assert.equal(empty.state.doc.toString(), "");
  assert.equal(empty.state.selection.main.from, 0);
});

test("italic formatting preserves bold whether the selection includes its markers or only its text", () => {
  for (const [from, to] of [
    [0, 8],
    [2, 6],
  ]) {
    const e = editor("**bold**", from, to);
    e.run(wrapMarkdown("*", "italic text"));
    assert.equal(e.state.doc.toString(), "***bold***");
    e.run(wrapMarkdown("*", "italic text"));
    assert.equal(e.state.doc.toString(), "**bold**");
  }
});

test("list formatting includes selected lines without changing the next unselected line", () => {
  const e = editor("one\ntwo\nthree", 0, 8);
  e.run(prefixMarkdown("- "));
  assert.equal(e.state.doc.toString(), "- one\n- two\nthree");
  e.run(prefixMarkdown("- "));
  assert.equal(e.state.doc.toString(), "one\ntwo\nthree");
});

test("link formatting selects its destination and read-only documents reject mutations", () => {
  const e = editor("Read the guide", 9, 14);
  e.run(insertMarkdownLink);
  assert.equal(e.state.doc.toString(), "Read the [guide](https://)");
  assert.equal(
    e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to),
    "https://",
  );
  const locked = editor("Protected", 0, 9, true);
  for (const command of [
    wrapMarkdown("**", "bold text"),
    prefixMarkdown("## "),
    insertMarkdownLink,
  ]) {
    assert.equal(locked.run(command), false);
    assert.equal(locked.state.doc.toString(), "Protected");
  }
});
