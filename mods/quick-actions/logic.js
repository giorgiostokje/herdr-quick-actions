// The parts of Quick actions that touch no window: reading and editing
// quick-actions.json, and building the shell script that runs an action.
//
// The file is a list, shown in file order. An action:
//   { "name": "Search", "description": "optional",
//     "command": "open \"https://example.com/?q=$VALUE_URLENCODED\"",
//     "input": ... }                       optional, what to ask for first
// input is one of:
//   { "prompt": "Search for" }             type a value
//   { "prompt": "?", "choices": ["a", { "label": "B", "value": "b" }] }
//   { "prompt": "?", "choices_command": "ls -1" }   one per line: label<tab>value
// The answer reaches the command as $VALUE, and URL-encoded as $VALUE_URLENCODED.
// Commands run in the focused folder, under sh.

// --- Reading.

function inputProblem(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  if (input.choices !== undefined && input.choices_command !== undefined) return "input has both choices and choices_command";
  if (input.choices_command !== undefined && !String(input.choices_command).trim()) return "choices_command is empty";
  if (input.choices === undefined) return null;
  if (!Array.isArray(input.choices) || !input.choices.length) return "choices must be a list with something in it";
  const ok = (c) => (typeof c === "string" ? c : c?.label);
  return input.choices.every(ok) ? null : "each choice needs a label";
}

// The problem with an action, or null.
export function problemWith(a) {
  if (a === null || typeof a !== "object" || Array.isArray(a)) return "expected an object";
  if (!a.name) return "name is required";
  if (!String(a.command ?? "").trim()) return "command is required";
  return a.input === undefined ? null : inputProblem(a.input);
}

// doc: the file's list as written, null if it can't be edited safely.
// actions: one per entry, in order; a bad one is { index, error }, others still work.
export function loadActions(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { doc: null, actions: [{ error: `quick-actions.json: ${e.message}` }] };
  }
  if (!Array.isArray(doc)) return { doc: null, actions: [{ error: "quick-actions.json: expected a list of actions" }] };
  const actions = doc.map((a, index) => {
    const error = problemWith(a);
    return error ? { index, error: `quick-actions.json, action ${index + 1}: ${error}` } : { ...a, index };
  });
  return { doc, actions };
}

export function choiceOf(c) {
  return typeof c === "string" ? { label: c, value: c } : { label: c.label, value: c.value ?? c.label };
}

// choices_command output: "label" or "label<tab>value" per line.
export function choicesFromOutput(out) {
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return tab < 0 ? { label: l, value: l } : { label: l.slice(0, tab).trim(), value: l.slice(tab + 1).trim() };
  });
}

// --- Editing: what the form shows, and back. Fields the form doesn't know stay.

const CHOICE_SEP = " = ";

export function draftOf(a) {
  const input = a?.input;
  const mode = !input ? "none" : input.choices ? "list" : input.choices_command !== undefined ? "command" : "text";
  return {
    name: a?.name ?? "",
    description: a?.description ?? "",
    command: a?.command ?? "",
    mode,
    prompt: input?.prompt ?? "",
    choices: (input?.choices ?? []).map(choiceOf).map((c) => (c.label === c.value ? c.label : `${c.label}${CHOICE_SEP}${c.value}`)).join("\n"),
    choices_command: input?.choices_command ?? "",
  };
}

function choicesFromText(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const at = l.indexOf(CHOICE_SEP);
    if (at < 0) return l;
    const label = l.slice(0, at).trim();
    const value = l.slice(at + CHOICE_SEP.length).trim();
    return label === value ? label : { label, value };
  });
}

// { entry }, or { error } in words for the form.
export function entryFromDraft(d, original = {}) {
  const { index: _index, ...kept } = original;
  const entry = { ...kept, name: d.name.trim(), command: d.command.trim() };
  if (!entry.name) return { error: "Give the action a name." };
  if (!entry.command) return { error: "Give the action a command." };
  if (d.description.trim()) entry.description = d.description.trim();
  else delete entry.description;
  delete entry.input;
  if (d.mode !== "none") {
    const { choices: _c, choices_command: _cc, prompt: _p, ...inputKept } = original.input ?? {};
    const input = { ...inputKept };
    if (d.prompt.trim()) input.prompt = d.prompt.trim();
    if (d.mode === "list") {
      input.choices = choicesFromText(d.choices);
      if (!input.choices.length) return { error: "Add at least one choice." };
    }
    if (d.mode === "command") {
      input.choices_command = d.choices_command.trim();
      if (!input.choices_command) return { error: "Give the command that lists the choices." };
    }
    entry.input = input;
  }
  return { entry };
}

// A new list: index null adds at the end, entry null removes.
export function editedDoc(doc, index, entry) {
  if (index === null) return [...doc, entry];
  return entry ? doc.map((a, i) => (i === index ? entry : a)) : doc.filter((_a, i) => i !== index);
}

export function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --- Running.

export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Like Go's url.QueryEscape: safe in a query string, spaces as +.
export function urlEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

// Runs an action in its own terminal. The terminal goes when the command ends,
// so a failure stays on screen until read; otherwise its output would vanish.
export function actionScript(command, value) {
  const env = value === null || value === undefined ? "" : `VALUE=${shellQuote(value)} VALUE_URLENCODED=${shellQuote(urlEncode(value))} `;
  return `${env}sh -c ${shellQuote(command)}; c=$?; if [ "$c" -ne 0 ]; then printf '\\n— exit code %s · press Enter to close —\\n' "$c"; read _ </dev/tty; fi; exit "$c"`;
}

// The actions still running: the terminals this mod labelled, so the core is the
// only record of them.
export const RUN_LABEL = "quick-action";

export function runningActions(terminals) {
  return terminals
    .filter((t) => t.state === "live" && t.labels?.[RUN_LABEL])
    .map((t) => ({ terminal: t.address, name: t.labels[RUN_LABEL] }));
}

// Whether `hc get --json <t>` says the terminal still runs. A finished one is gone
// (`--rm`), so hc answers not_found with a nonzero code.
export function liveInCore(result) {
  if (result.code !== 0) return false;
  try {
    return JSON.parse(result.stdout).state === "live";
  } catch {
    return false;
  }
}

// A valid `hc run --name`: 1-32 of a-z 0-9 - _, unique among live terminals.
export function terminalName(actionName, unique) {
  const slug = actionName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 25).replace(/-+$/, "");
  return `${slug || "action"}-${unique}`;
}

// --- Keys: Herdr's defaults use cmd on macOS and ctrl+shift elsewhere, and cmd means
// the Super or Windows key there, which the system may keep for itself.

export function primaryKeyHeld(mac, modifiers) {
  return mac ? modifiers.platform : modifiers.control;
}

export function primaryKeyLabel(mac, key) {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

// --- Filtering: the query's letters in order, best near starts of words.

export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const s = text.toLowerCase();
  let score = 0;
  let at = -1;
  for (const ch of q) {
    const next = s.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (next === at + 1) score += 3;
    if (next === 0 || /[^a-z0-9]/.test(s[next - 1])) score += 4;
    score -= Math.min(next - at - 1, 3);
    at = next;
  }
  return score;
}

// Best first; items that don't match are left out. Name counts over description.
export function rank(items, query, nameOf, moreOf) {
  return items
    .map((item) => {
      const name = fuzzyScore(query, nameOf(item));
      const more = fuzzyScore(query, `${nameOf(item)} ${moreOf(item) ?? ""}`);
      const score = name ?? (more === null ? null : more - 8);
      return { item, score };
    })
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
