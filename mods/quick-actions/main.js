// Quick actions: a fuzzy launcher for one-off commands, kept in quick-actions.json
// in the app's home (logic.js has the format). Create and edit them here, or in
// the file. An action runs in the focused folder, in its own terminal, over the
// tab with a bar on top: minimize, keep as a tab, or stop. A minimized action is
// listed under Running here until it ends.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { appHome, closeOverlay, exec, openOverlay, focused, hc, home, notify, props, readTextFile, run, setShared, settings, shared, spaces, terminals, theme, window as win, writeTextFile } from "herdr";
import { RUN_LABEL, actionScript, choiceOf, choicesFromOutput, draftOf, editedDoc, entryFromDraft, liveInCore, loadActions, primaryKeyHeld, primaryKeyLabel, rank, runningActions, serialize, terminalName } from "./logic.js";

const ROW_H = 32;
const HEAD_H = 26;
const SHOWN = 10;
// How long a command may take and still not open a terminal over the tab: one
// that is already done (`open <url>`) has nothing to show.
const SHOW_AFTER_MS = 150;
// The app lists a terminal some 300 ms after the core starts it (Herdr 0.1.12), and
// the run opens over the tab only once it does.
const LIST_WAIT_MS = 2000;
const LIST_POLL_MS = 25;
const READ_AFTER_MS = 150;
const GETS_VALUE = "The command gets it as $VALUE, and as $VALUE_URLENCODED for a web address.";
const MODES = [
  ["none", "Run right away", "The command runs as soon as you select the action."],
  ["text", "Ask me to type", `You type a value first. ${GETS_VALUE}`],
  ["list", "Pick from my list", `You pick from the list below first. ${GETS_VALUE}`],
  ["command", "Pick from a command's output", `A second command makes the list, and you pick from it first. ${GETS_VALUE}`],
];

const COPY_KEY = "quick-actions.file";
const isMac = () => win()?.platform === "macos";
const actionsFile = () => `${appHome()}/quick-actions.json`;

// A running action over the tab: its terminal under this mod's bar.
function showRun(terminal, name) {
  openOverlay({
    kind: "dialog",
    key: `quick-action-${terminal}`,
    width: 0.8,
    height: 0.8,
    layout: {
      type: "column",
      children: [
        { type: "block", size: { px: 34 }, content: { mod: "quick-actions", props: { part: "bar", terminal, name } } },
        { type: "block", content: { terminal } },
      ],
    },
  });
}

// Whether a just-started action can open over the tab: it isn't done yet, and the
// app lists its terminal. Asks the core first, not terminals(): the app doesn't
// list the terminal yet at this point. False leaves it under Running.
async function showable(terminal, cx) {
  await cx.sleep(SHOW_AFTER_MS);
  if (!liveInCore(await hc(["get", "--json", terminal]))) return false;
  for (let waited = 0; waited < LIST_WAIT_MS; waited += LIST_POLL_MS) {
    if (terminals().some((t) => t.address === terminal && t.state === "live")) return true;
    await cx.sleep(LIST_POLL_MS);
  }
  return false;
}

export default class QuickActions extends View {
  init(_props, cx) {
    if (props()?.part === "bar") return;
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    this.folder = f?.cwd || space?.folder || home();
    this.machine = space?.machine ?? null;
    this.stage = "actions"; // or "select", "text", "edit", "raw"
    this.raw = null; // The file as read: writing refuses if it changed since.
    this.doc = null; // Its list, null if it can't be edited.
    this.actions = null; // null until read
    this.action = null;
    this.choices = null; // null while a choices_command runs
    this.choicesError = null;
    this.edit = null;
    this.rawEdit = null;
    this.query = "";
    this.at = 0;
    this.top = 0;
    this.starting = false;
    this.handle = cx.focus_handle();

    this.input = InputState.new({ placeholder: "Type to filter…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.top = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.activate(this.selectable()[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => { if (this.stage === "actions") this.input.focus(); });

    // Rows must be there on the first frame, as in the palette, and a read can't do
    // that: it finishes later, and the redraw then held the app up for about a second
    // (measured, the shipped picker does it too). So draw from a copy in shared(), which
    // answers at once, then read the file. The file stays the only source: it replaces
    // the copy when different, and a Save against a stale copy is refused.
    // Not localStorage: an overlay's store is per overlay id, so it's empty on each open.
    const copy = shared(COPY_KEY) ?? null;
    if (copy !== null) {
      this.raw = copy;
      this.load(copy);
    }
    cx.timer.after(READ_AFTER_MS, (cx) => {
      cx.spawn(async (cx) => {
        try {
          const raw = await readTextFile(actionsFile());
          if (raw === this.raw && this.actions !== null) return;
          if (this.stage === "edit" || this.stage === "raw") return; // Save compares against what it opened with.
          this.raw = raw;
          this.load(raw ?? "[]");
          this.keepCopy(raw);
        } catch (e) {
          if (this.actions === null) this.actions = [{ error: `quick-actions.json: ${e.message}` }];
        }
        cx.notify();
      });
    });
  }

  keepCopy(raw) {
    if ((shared(COPY_KEY) ?? null) !== raw) setShared(COPY_KEY, raw);
  }

  load(text) {
    const { doc, actions } = loadActions(text);
    this.doc = doc;
    this.actions = actions;
  }

  close() {
    closeOverlay(props().overlay);
  }

  // The run over the tab, in place of this picker. Close first: the run's terminal
  // gets the keyboard only then, as closing the picker after it gives the keyboard
  // back to the pane below.
  closeAndShow(terminal, name) {
    this.close();
    showRun(terminal, name);
  }

  back(cx) {
    this.stage = "actions";
    this.action = null;
    this.choices = null;
    this.choicesError = null;
    this.edit = null;
    this.rawEdit?.state?.release();
    this.rawEdit = null;
    this.input.set_value("");
    this.query = "";
    this.at = 0;
    this.top = 0;
    this.input.focus();
    cx.notify();
  }

  // Every row of the list, headings included.
  rows() {
    if (this.stage === "select") return this.choiceRows();
    const running = this.query.trim() ? [] : runningActions(terminals()).map((r) => ({ kind: "pick", id: `r-${r.terminal}`, name: r.name, description: "running", run: r }));
    return [...(running.length ? [{ kind: "head", text: "Running" }, ...running, { kind: "head", text: "Actions" }] : []), ...this.actionRows()];
  }

  actionRows() {
    if (this.actions === null) return [{ kind: "note", text: "Loading…" }];
    const bad = this.actions.filter((a) => a.error).map((a) => ({ kind: "problem", text: a.error }));
    const good = this.actions.filter((a) => !a.error);
    const row = (a) => ({ kind: "pick", id: `a-${a.index}`, name: a.name, description: a.description, action: a });
    if (this.query.trim()) {
      const hits = rank(good, this.query, (a) => a.name, (a) => a.description).map(row);
      return [...bad, ...(hits.length ? hits : [{ kind: "note", text: "No matching actions" }])];
    }
    return [
      ...bad,
      ...good.map(row),
      ...(this.doc ? [{ kind: "pick", id: "a-new", name: "New action", icon: "plus", isNew: true }] : []),
      { kind: "pick", id: "a-raw", name: "Edit quick-actions.json", icon: "file-text", isRaw: true },
    ];
  }

  choiceRows() {
    if (this.choicesError) return [{ kind: "problem", text: this.choicesError }];
    if (this.choices === null) return [{ kind: "note", text: "Loading…" }];
    const list = this.query.trim() ? rank(this.choices, this.query, (c) => c.label, () => "") : this.choices;
    if (!list.length) return [{ kind: "note", text: this.query.trim() ? "No matching choices" : "No choices" }];
    return list.map((c) => ({ kind: "pick", id: `c-${this.choices.indexOf(c)}`, name: c.label, value: c.value }));
  }

  selectable() {
    return this.rows().filter((r) => r.kind === "pick");
  }

  activate(row, cx) {
    if (!row) return;
    if (row.run) return this.closeAndShow(row.run.terminal, row.run.name);
    if (row.isNew) return this.openEditor(null, cx);
    if (row.isRaw) return this.openRaw(cx);
    if (row.value !== undefined) return this.start(this.action, row.value, cx);
    const a = row.action;
    if (!a.input) return this.start(a, null, cx);
    if (a.input.choices || a.input.choices_command !== undefined) return this.openSelect(a, cx);
    this.openText(a, cx);
  }

  openText(a, cx) {
    this.action = a;
    this.stage = "text";
    this.field = InputState.new({ placeholder: "Type a value…" });
    this.field.on("submit", (_e, cx) => this.start(a, this.field.value().trim(), cx));
    this.field.focus();
    cx.notify();
  }

  openSelect(a, cx) {
    this.action = a;
    this.stage = "select";
    this.input.set_value("");
    this.query = "";
    this.at = 0;
    this.top = 0;
    if (a.input.choices) {
      this.choices = a.input.choices.map(choiceOf);
      return cx.notify();
    }
    this.choices = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", a.input.choices_command], { cwd: this.folder, on: this.machine });
        if (this.action !== a) return; // Went back while it ran.
        if (r.code === 0) this.choices = choicesFromOutput(r.stdout);
        else this.choicesError = `choices_command failed (${r.code}): ${r.stderr.trim()}`;
      } catch (e) {
        if (this.action !== a) return;
        this.choicesError = e.message;
      }
      cx.notify();
    });
  }

  fail(body) {
    notify({ title: "Quick action failed", body, level: "error" });
    this.close();
  }

  start(action, value, cx) {
    if (this.starting) return;
    this.starting = true;
    cx.notify();
    const on = this.machine;
    cx.spawn(async (cx) => {
      try {
        const name = terminalName(action.name, Date.now().toString(36).slice(-5));
        const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--rm", "--name", name, "--label", `${RUN_LABEL}=${action.name}`, "--cwd", this.folder, ...(on ? ["--on", on] : []), "--", "sh", "-c", actionScript(action.command, value)]);
        if (r.code !== 0) return this.fail(`${action.name}: ${r.stderr.trim() || r.stdout.trim()}`);
        const address = JSON.parse(r.stdout).address;
        const terminal = on && !address.includes("/") ? `${on}/${address}` : address;
        if (await showable(terminal, cx)) this.closeAndShow(terminal, action.name);
        else this.close();
      } catch (e) {
        this.fail(`${action.name}: ${e.message}`);
      }
    });
  }

  // --- The form that creates and edits an action.

  openEditor(action, cx) {
    const d = draftOf(action);
    const line = (key, placeholder) => InputState.new({ value: d[key], placeholder });
    const area = (key, placeholder, rows) => TextareaState.new({ value: d[key], placeholder, rows });
    const fields = {
      name: line("name", "Update everything"),
      description: line("description", "Optional"),
      command: area("command", "brew update && brew upgrade", 3),
      prompt: line("prompt", "Optional"),
      choices: area("choices", "First choice\nSecond = value-to-use", 4),
      choices_command: line("choices_command", "ls -1"),
    };
    Object.entries(fields).forEach(([key, state]) => {
      state.on("focus", () => { if (this.edit) this.edit.focused = key; });
      if (!["command", "choices"].includes(key)) state.on("submit", (_e, cx) => this.save(cx));
    });
    this.edit = { index: action ? action.index : null, original: action ?? {}, fields, mode: d.mode, error: null, confirmDelete: false, focused: "name", saving: false };
    this.stage = "edit";
    fields.name.focus();
    cx.notify();
  }

  // The fields the form shows now, in order.
  shownFields() {
    const mode = this.edit.mode;
    return ["name", "description", "command", ...(mode === "none" ? [] : ["prompt"]), ...(mode === "list" ? ["choices"] : []), ...(mode === "command" ? ["choices_command"] : [])];
  }

  moveFocus(step) {
    const shown = this.shownFields();
    const at = shown.indexOf(this.edit.focused);
    const next = shown[(at + step + shown.length) % shown.length];
    this.edit.focused = next;
    this.edit.fields[next].focus();
  }

  draft() {
    const { fields, mode } = this.edit;
    return { mode, ...Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.value()])) };
  }

  save(cx) {
    const { entry, error } = entryFromDraft(this.draft(), this.edit.original);
    if (error) {
      this.edit.error = error;
      return cx.notify();
    }
    this.write(entry, cx);
  }

  remove(cx) {
    if (!this.edit.confirmDelete) {
      this.edit.confirmDelete = true;
      return cx.notify();
    }
    this.write(null, cx);
  }

  write(entry, cx) {
    const index = this.edit.index;
    this.putFile(this.edit, serialize(editedDoc(this.doc, index, entry)), cx, () => {
      // Back on the action just saved.
      const saved = index === null ? this.doc.length - 1 : index;
      if (entry) this.at = Math.max(0, this.selectable().findIndex((r) => r.action?.index === saved));
    });
  }

  putFile(form, text, cx, after) {
    if (form.saving) return;
    form.saving = true;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(actionsFile(), text, this.raw);
      } catch (e) {
        form.saving = false;
        form.error = `Not saved. ${e.message.replace(/^`[^`]+`: /, "")}`;
        return cx.notify();
      }
      this.raw = text;
      this.load(text);
      this.keepCopy(text);
      this.back(cx);
      after?.();
      cx.notify();
    });
  }

  // --- The file itself, in an editor. It also opens when the file is broken, so
  // it can be repaired here.

  openRaw(cx) {
    this.stage = "raw";
    this.rawEdit = { state: null, error: null, saving: false };
    this.handle.focus();
    cx.notify();
    const form = this.rawEdit;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(actionsFile());
        if (this.rawEdit !== form) return; // Went back while it read.
        this.raw = raw;
        const t = theme();
        form.state = EditorState.new({
          language: "json",
          value: raw ?? serialize([]),
          font_family: settings().font_family,
          font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
      } catch (e) {
        form.error = `Could not read the file. ${e.message.replace(/^`[^`]+`: /, "")}`;
      }
      cx.notify();
    });
  }

  saveRaw(cx) {
    const form = this.rawEdit;
    if (!form.state) return;
    const text = form.state.value();
    const { doc, actions } = loadActions(text);
    if (!doc) {
      form.error = `Not saved. ${actions[0].error}`;
      return cx.notify();
    }
    this.putFile(form, text, cx);
  }

  key(e, cx, picks) {
    const k = e.key;
    const { control: ctrl, shift } = e.modifiers;
    const primary = primaryKeyHeld(isMac(), e.modifiers);
    if (k === "escape") {
      if (this.stage === "actions") this.close();
      else this.back(cx);
    } else if (k === "c" && ctrl) this.close();
    else if (this.stage === "raw") {
      if (k === "enter" && primary) this.saveRaw(cx);
      else return;
    } else if (this.stage === "edit") {
      if (k === "tab") this.moveFocus(shift ? -1 : 1);
      else if (k === "enter" && primary) this.save(cx);
      else return;
    } else if (this.stage === "text") return;
    else if (k === "e" && primary) {
      const a = picks[this.at]?.action;
      if (!a || !this.doc) return;
      this.openEditor(a, cx);
    } else if (k === "down" || (k === "n" && ctrl)) this.at = Math.min(this.at + 1, picks.length - 1);
    else if (k === "up" || (k === "p" && ctrl)) this.at = Math.max(this.at - 1, 0);
    else if (k === "pagedown") this.at = Math.min(this.at + SHOWN, picks.length - 1);
    else if (k === "pageup") this.at = Math.max(this.at - SHOWN, 0);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // A row of the list. `on`: the selected one.
  row(t, r, on) {
    if (r.kind === "head") return h_flex().h(HEAD_H).flex_none().px(14).pb(4).items_end().text_size(11).font_semibold().text_color(t.dim).child(r.text);
    if (r.kind === "note") return h_flex().h(ROW_H).flex_none().px(14).items_center().text_size(12.8).text_color(t.dim).child(div().truncate().child(r.text));
    if (r.kind === "problem") return h_flex().h(ROW_H).flex_none().px(14).items_center().text_size(12.8).text_color(t.blocked).child(div().truncate().child(r.text));
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex()
      .id(r.id)
      .h(ROW_H)
      .flex_none()
      .mx(6)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .text_size(12.8)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.activate(r, cx))
      .when(Boolean(r.icon), (el) => el.child(svg(`mods/workspace-chrome/${r.icon}.svg`).size(14).flex_none().text_color(t.dim)))
      .child(div().flex_none().max_w(320).truncate().text_color(on ? t.foreground : t.muted).child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.description ?? ""))
      .when(Boolean(r.action && this.doc), (el) =>
        el.child(
          h_flex()
            .id(`edit-${r.id}`)
            .size(22)
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(5)
            .text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.openEditor(r.action, cx); })
            .child(svg("mods/workspace-chrome/square-pen.svg").size(13)),
        ),
      );
  }

  list(t, rows, picks) {
    this.at = Math.min(this.at, Math.max(0, picks.length - 1));
    const sel = picks[this.at];
    const index = sel ? rows.indexOf(sel) : 0;
    // A window of rows that follows the selection, and shows its heading.
    const from = index > 0 && rows[index - 1].kind === "head" ? index - 1 : index;
    if (from < this.top) this.top = from;
    if (index >= this.top + SHOWN) this.top = index - SHOWN + 1;
    const maxTop = Math.max(0, rows.length - SHOWN);
    this.top = Math.min(this.top, maxTop);
    return v_flex()
      .id("qa-rows")
      .flex_none()
      .pb(6)
      .on_scroll_wheel((e, cx) => {
        // Wheels report lines, touchpads pixels.
        const lines = Math.abs(e.delta.y) < 4 ? e.delta.y : e.delta.y / ROW_H;
        const step = lines > 0 ? Math.ceil(lines) : Math.floor(lines);
        this.top = Math.max(0, Math.min(this.top - step, maxTop));
        // The selection stays on screen, so the next frame doesn't scroll back to it.
        const shown = rows.slice(this.top, this.top + SHOWN).filter((r) => r.kind === "pick");
        if (shown.length && !shown.includes(picks[this.at])) this.at = picks.indexOf(shown[step > 0 ? shown.length - 1 : 0]);
        cx.notify();
      })
      .children(rows.slice(this.top, this.top + SHOWN).map((r) => this.row(t, r, r === sel)));
  }

  button(t, id, label, style, act) {
    const primary = style === "primary";
    return h_flex()
      .id(id)
      .h(32)
      .px(14)
      .flex_none()
      .items_center()
      .rounded(8)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : style === "danger" ? t.blocked : t.foreground)
      .text_size(12.5)
      .font_medium()
      .cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_click(act)
      .child(label);
  }

  // The form: what the action is, what it asks for, then save.
  editor(t) {
    const { fields, mode, error, confirmDelete, index } = this.edit;
    const label = (text) => div().text_size(11.5).text_color(t.dim).child(text);
    const hint = (text) => div().text_size(11.5).text_color(t.dim).child(text);
    const framed = (el) => el.rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const line = (key) => framed(Input.new(fields[key])).h(36).px(10);
    const area = (key, height) => framed(Textarea.new(fields[key])).h(height).p(10);
    const group = (title, ...children) => v_flex().flex_none().gap(6).child(label(title)).children(children);
    const mark = (m, text) =>
      h_flex()
        .id(`mode-${m}`)
        .h(28)
        .px(10)
        .flex_none()
        .items_center()
        .rounded(7)
        .border_1()
        .border_color(mode === m ? t.accent : t.input)
        .bg(mode === m ? t.selected : t.background)
        .text_size(12)
        .text_color(mode === m ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.edit.mode = m;
          this.edit.error = null;
          cx.notify();
        })
        .child(text);
    return v_flex()
      .gap(12)
      .child(group("Name", line("name")))
      .child(group("Description", line("description")))
      .child(group("Command", area("command", 88), hint("It runs in the folder you are working in.")))
      .child(group("Before it runs", h_flex().gap(6).children(MODES.map(([m, text]) => mark(m, text))), hint(MODES.find(([m]) => m === mode)[2])))
      .when(mode !== "none", (el) => el.child(group("Question to show", line("prompt"))))
      .when(mode === "list", (el) => el.child(group("Choices", area("choices", 108), hint("Write one choice per line. To send something other than the label, write Label = value."))))
      .when(mode === "command", (el) => el.child(group("Command that makes the list", line("choices_command"), hint("It prints one choice per line. To send something other than the label, print the label, a tab, then the value."))))
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .when(index !== null, (el) => el.child(this.button(t, "qa-delete", confirmDelete ? "Confirm delete" : "Delete", "danger", (_e, cx) => this.remove(cx))))
          .child(div().flex_1())
          .child(this.button(t, "qa-cancel", "Cancel", "plain", (_e, cx) => this.back(cx)))
          .child(this.button(t, "qa-save", "Save", "primary", (_e, cx) => this.save(cx))),
      );
  }

  rawEditor(t) {
    const { state, error } = this.rawEdit;
    return v_flex()
      .gap(12)
      .child(
        state
          ? Editor.new(state).h(440).rounded(9).border_1().border_color(t.input).bg(t.background)
          : div().h(440).p(10).text_size(12.8).text_color(t.dim).child(error ? "" : "Loading…"),
      )
      .child(div().text_size(11.5).text_color(t.dim).child("~/.config/herdr-app/quick-actions.json"))
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .child(div().flex_1())
          .child(this.button(t, "qa-raw-cancel", "Cancel", "plain", (_e, cx) => this.back(cx)))
          .child(this.button(t, "qa-raw-save", "Save", "primary", (_e, cx) => this.saveRaw(cx))),
      );
  }

  // The bar on top of a running action. Stopping ends the terminal, and with it
  // the overlay; minimizing only closes the overlay.
  bar(t) {
    const { terminal, name, overlay } = props();
    const button = (id, label, act) =>
      div()
        .id(id)
        .px(8)
        .py(2)
        .rounded(5)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(act)
        .child(label);
    return h_flex()
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().flex_1().truncate().font_semibold().text_color(t.foreground).child(name))
      .child(button("qa-minimize", "– minimize", () => closeOverlay(overlay)))
      .child(button("qa-keep", "↗ keep as tab", () => { run("terminal.keep", { terminal }); closeOverlay(overlay); }))
      .child(button("qa-stop", "✕ stop", () => { run("terminal.kill", { terminal }); closeOverlay(overlay); }));
  }

  render() {
    const t = theme();
    if (props()?.part === "bar") return this.bar(t);
    const editing = this.stage === "edit";
    const rawEditing = this.stage === "raw";
    const rows = editing || rawEditing ? [] : this.rows();
    const picks = rows.filter((r) => r.kind === "pick");
    const title = rawEditing ? "Edit quick-actions.json" : editing ? (this.edit.index === null ? "New action" : `Edit ${this.edit.original.name}`) : this.action ? this.action.name : "Quick Actions";
    const corner = this.starting ? "Starting…" : this.stage === "actions" ? `${primaryKeyLabel(isMac(), "E")} edit · Esc` : "Esc to go back";
    const prompt = this.action?.input?.prompt;
    const box = (state, icon) =>
      h_flex()
        .h(36)
        .flex_none()
        .px(10)
        .gap(8)
        .items_center()
        .rounded(9)
        .border_1()
        .border_color(t.accent)
        .bg(t.background)
        .when(icon, (el) => el.child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim)))
        .child(Input.new(state).flex_1().h_full().text_size(12.8).text_color(t.foreground));
    return v_flex()
      .id("quick-actions")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => this.key(e, cx, picks))
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .child(div().flex_1().truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(corner)),
      )
      .when(editing, (el) => el.child(this.editor(t)))
      .when(rawEditing, (el) => el.child(this.rawEditor(t)))
      .when(this.stage === "text", (el) => el.child(div().text_size(11.5).text_color(t.dim).child(prompt || "Enter a value")).child(box(this.field, false)))
      .when(this.stage === "select" && Boolean(prompt), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(prompt)))
      .when(this.stage === "actions" || this.stage === "select", (el) => el.child(box(this.input, true)).child(this.list(t, rows, picks)));
  }
}
