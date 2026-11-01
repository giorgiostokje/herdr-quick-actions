// node --test ~/.config/herdr-app/mods/quick-actions/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { RUN_LABEL, actionScript, choiceOf, choicesFromOutput, draftOf, editedDoc, entryFromDraft, fuzzyScore, loadActions, problemWith, rank, runningActions, serialize, shellQuote, terminalName, urlEncode, primaryKeyHeld, primaryKeyLabel } from "./logic.js";

const sh = (script) => execFileSync("sh", ["-c", script], { encoding: "utf8" });

test("loads actions in file order, with their index", () => {
  const { doc, actions } = loadActions(JSON.stringify([{ name: "b", command: "c" }, { name: "a", command: "c", input: {} }]));
  assert.equal(doc.length, 2);
  assert.deepEqual(actions.map((a) => [a.name, a.index]), [["b", 0], ["a", 1]]);
});

test("a bad entry says which and why, keeps the doc, and the others still load", () => {
  const { doc, actions } = loadActions(JSON.stringify([{ command: "c" }, 3, { name: "ok", command: "c" }]));
  assert.match(actions[0].error, /action 1: name is required/);
  assert.match(actions[1].error, /action 2: expected an object/);
  assert.equal(actions[2].name, "ok");
  assert.equal(doc.length, 3);
});

test("a broken file can't be edited, so it can't be overwritten", () => {
  assert.equal(loadActions("{ nope").doc, null);
  assert.match(loadActions("{ nope").actions[0].error, /^quick-actions\.json: /);
  assert.equal(loadActions("{}").doc, null);
});

test("rejects contradictory or empty inputs", () => {
  const base = { name: "x", command: "c" };
  assert.equal(problemWith(base), null);
  assert.equal(problemWith({ ...base, input: { prompt: "p" } }), null);
  assert.equal(problemWith({ ...base, input: { choices: ["a"] } }), null);
  assert.equal(problemWith({ ...base, input: { choices_command: "ls" } }), null);
  assert.match(problemWith({ ...base, input: { choices: ["a"], choices_command: "ls" } }), /both/);
  assert.match(problemWith({ ...base, input: { choices: [] } }), /choices/);
  assert.match(problemWith({ ...base, input: { choices: [{ value: "v" }] } }), /label/);
  assert.match(problemWith({ ...base, input: { choices_command: " " } }), /empty/);
  assert.match(problemWith({ ...base, input: "x" }), /object/);
  assert.match(problemWith({ name: "x" }), /command/);
});

test("choices: a string is both label and value", () => {
  assert.deepEqual(choiceOf("a"), { label: "a", value: "a" });
  assert.deepEqual(choiceOf({ label: "A", value: "a" }), { label: "A", value: "a" });
  assert.deepEqual(choiceOf({ label: "A" }), { label: "A", value: "A" });
});

test("choices_command output: label, or label<tab>value", () => {
  assert.deepEqual(choicesFromOutput("one\n\n  Two\t2 \n"), [{ label: "one", value: "one" }, { label: "Two", value: "2" }]);
});

test("the form round-trips every kind of action, and keeps fields it doesn't know", () => {
  const cases = [
    { name: "plain", command: "c", extra: 1 },
    { name: "text", description: "d", command: "c", input: { prompt: "p", extra: 2 } },
    { name: "list", command: "c", input: { prompt: "p", choices: ["a", { label: "B", value: "b = c" }] } },
    { name: "cmd", command: "c", input: { choices_command: "ls" } },
  ];
  for (const a of cases) assert.deepEqual(entryFromDraft(draftOf(a), a).entry, a, a.name);
});

test("a new action starts empty, and the form says what's missing", () => {
  const d = draftOf(null);
  assert.equal(d.mode, "none");
  assert.match(entryFromDraft(d).error, /name/);
  assert.match(entryFromDraft({ ...d, name: "x" }).error, /command/);
  assert.match(entryFromDraft({ ...d, name: "x", command: "c", mode: "list" }).error, /choice/);
  assert.match(entryFromDraft({ ...d, name: "x", command: "c", mode: "command" }).error, /lists the choices/);
});

test("changing the input kind leaves nothing of the old one", () => {
  const a = { name: "x", description: "d", command: "c", input: { prompt: "p", choices: ["a"] }, index: 4 };
  assert.deepEqual(entryFromDraft({ ...draftOf(a), mode: "none", description: "" }, a).entry, { name: "x", command: "c" });
  assert.deepEqual(entryFromDraft({ ...draftOf(a), mode: "text" }, a).entry.input, { prompt: "p" });
});

test("edits add at the end, replace in place and remove", () => {
  const doc = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(editedDoc(doc, null, { name: "c" }).map((a) => a.name), ["a", "b", "c"]);
  assert.deepEqual(editedDoc(doc, 0, { name: "z" }).map((a) => a.name), ["z", "b"]);
  assert.deepEqual(editedDoc(doc, 0, null).map((a) => a.name), ["b"]);
  assert.deepEqual(JSON.parse(serialize(doc)), doc);
});

test("the answer reaches the command intact, whatever it holds", () => {
  const nasty = `a b; touch /tmp/never 'q' "d" $HOME`;
  assert.equal(sh(actionScript('printf %s "$VALUE"', nasty)), nasty);
  assert.equal(sh(actionScript('printf %s "$VALUE_URLENCODED"', "a b&c/d'é")), "a+b%26c%2Fd%27%C3%A9");
});

test("an action with no input gets no VALUE, and an empty answer still counts", () => {
  assert.equal(sh(`unset VALUE; ${actionScript('printf %s "${VALUE-unset}"', null)}`), "unset");
  assert.equal(sh(actionScript('printf %s "${VALUE-unset}"', "")), "");
});

test("a failure keeps its exit code, and `exit` can't skip the message", () => {
  // No tty here, so `read` fails at once instead of waiting.
  const r = spawnSync("sh", ["-c", actionScript("echo boom; exit 7", null)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], detached: true });
  assert.equal(r.status, 7);
  assert.match(r.stdout, /boom\n\n— exit code 7 · press Enter to close —/);
});

test("shellQuote and urlEncode", () => {
  const s = `a'b"c $d \`e\``;
  assert.equal(sh(`printf %s ${shellQuote(s)}`), s);
  assert.equal(urlEncode("a b"), "a+b");
});

test("running actions come from live labelled terminals only", () => {
  assert.deepEqual(runningActions([
    { address: "t1", state: "live", labels: { [RUN_LABEL]: "Brew" } },
    { address: "t2", state: "live", labels: {} },
    { address: "t3", state: "live" },
    { address: "t4", state: "exited", labels: { [RUN_LABEL]: "Old" } },
  ]), [{ terminal: "t1", name: "Brew" }]);
});

test("terminal names fit hc's rule", () => {
  assert.match(terminalName("Homebrew: update & upgrade and a lot more words", "ab12"), /^[a-z0-9_-]{1,32}$/);
  assert.equal(terminalName("Homebrew: update", "ab12"), "homebrew-update-ab12");
  assert.equal(terminalName("!!!", "ab12"), "action-ab12");
});

test("the main shortcut key is cmd on macOS and ctrl elsewhere", () => {
  assert.equal(primaryKeyHeld(true, { platform: true, control: false }), true);
  assert.equal(primaryKeyHeld(true, { platform: false, control: true }), false);
  assert.equal(primaryKeyHeld(false, { platform: false, control: true }), true);
  assert.equal(primaryKeyHeld(false, { platform: true, control: false }), false);
  assert.equal(primaryKeyLabel(true, "E"), "⌘E");
  assert.equal(primaryKeyLabel(false, "E"), "Ctrl+E");
});

test("fuzzy filtering ranks word starts and names first", () => {
  assert.equal(fuzzyScore("xyz", "brew"), null);
  assert.ok(fuzzyScore("bu", "brew upgrade") > fuzzyScore("bu", "rebuild"));
  const items = [{ n: "Rebuild", d: "" }, { n: "Other", d: "brew stuff" }, { n: "Brew upgrade", d: "" }, { n: "None", d: "" }];
  assert.deepEqual(rank(items, "brew", (i) => i.n, (i) => i.d).map((i) => i.n), ["Brew upgrade", "Other"]);
});
