// Macro library + slash-command reference (Database section). The macros are
// curated, battle-tested classic/Legends socials (research-sourced, see
// app/src/data/macros.json); each card offers a guided copy flow — EQ's
// social editor takes one pasted line per box, so the stepper copies line 1,
// advances to line 2, and so on: click, alt-tab, paste, repeat.

import { useMemo, useState } from "react";
import macrosData from "../data/macros.json";
import commandsData from "../data/commands.json";
import Empty from "./Empty";

interface MacroDef {
  name: string;
  category: string;
  classes: string[];
  lines: string[];
  description: string;
  tips: string;
  source: string;
}

interface CommandDef {
  command: string;
  syntax: string;
  category: string;
  description: string;
  source: string;
}

const MACROS = macrosData as MacroDef[];
const COMMANDS = commandsData as CommandDef[];

const MACRO_CATEGORIES = [...new Set(MACROS.map((m) => m.category))].sort();
const MACRO_CLASSES = [...new Set(MACROS.flatMap((m) => m.classes))].sort();
const COMMAND_CATEGORIES = [...new Set(COMMANDS.map((c) => c.category))].sort();

const NAME_PLACEHOLDERS = [
  "Tankname",
  "Leadername",
  "Clericname",
  "Draggername",
  "Dragger",
  "Alice",
  "Bob",
];

function applyMacroName(line: string, name: string): string {
  const n = name.trim();
  if (!n) return line;
  let out = line;
  for (const token of NAME_PLACEHOLDERS) {
    out = out.replace(new RegExp(`\\b${token}\\b`, "g"), n);
  }
  return out;
}

/** One macro card with the guided per-line copy stepper. */
function MacroCard({ macro, macroName }: { macro: MacroDef; macroName: string }) {
  // Index of the next line the stepper will copy; null = fresh card.
  const [nextLine, setNextLine] = useState(0);
  const [flash, setFlash] = useState<number | null>(null);
  const lines = useMemo(
    () => macro.lines.map((line) => applyMacroName(line, macroName)),
    [macro.lines, macroName],
  );

  async function copyLine(i: number) {
    try {
      await navigator.clipboard.writeText(lines[i]);
      setFlash(i);
      window.setTimeout(() => setFlash((f) => (f === i ? null : f)), 900);
      setNextLine(Math.min(i + 1, lines.length));
    } catch {
      /* clipboard unavailable */
    }
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setFlash(-1);
      window.setTimeout(() => setFlash((f) => (f === -1 ? null : f)), 900);
    } catch {
      /* clipboard unavailable */
    }
  }

  const done = nextLine >= lines.length;

  return (
    <div className="macro-card">
      <div className="macro-head">
        <span className="macro-name">{macro.name}</span>
        <span className="drops-badge">{macro.category}</span>
        {macro.classes.length > 0 ? (
          macro.classes.map((c) => (
            <span key={c} className="drops-badge">
              {c}
            </span>
          ))
        ) : (
          <span className="drops-badge">All classes</span>
        )}
      </div>
      <p className="macro-desc">{macro.description}</p>
      <div className="macro-lines">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`macro-line${nextLine === i ? " next" : ""}${
              i < nextLine ? " done" : ""
            }`}
          >
            <span className="macro-line-no num">{i + 1}</span>
            <code className="macro-line-text">{line}</code>
            <button
              className="ghost small"
              onClick={() => void copyLine(i)}
              title="Copy this line, then paste it into the matching social line in EQ"
            >
              {flash === i ? "Copied ✓" : "Copy"}
            </button>
          </div>
        ))}
      </div>
      <div className="macro-actions">
        <button
          className="ghost small"
          onClick={() => void copyLine(done ? 0 : nextLine)}
          title="Guided mode: copies each line in order — paste into EQ between clicks"
        >
          {done
            ? "↺ Start over"
            : `Copy line ${nextLine + 1} of ${lines.length}`}
        </button>
        <button className="ghost small" onClick={() => void copyAll()}>
          {flash === -1 ? "Copied ✓" : "Copy all"}
        </button>
        {macro.source && (
          <a
            className="ghost small button-link"
            href={macro.source}
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        )}
        {macro.tips && <span className="hint macro-tips">{macro.tips}</span>}
      </div>
    </div>
  );
}

export default function MacrosTab() {
  const [view, setView] = useState<"macros" | "commands">("macros");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [klass, setKlass] = useState("");
  const [macroName, setMacroName] = useState("");

  const q = query.trim().toLowerCase();

  const shownMacros = useMemo(
    () =>
      MACROS.filter(
        (m) =>
          (category === "" || m.category === category) &&
          (klass === "" ||
            m.classes.length === 0 ||
            m.classes.includes(klass)) &&
          (q === "" ||
            m.name.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.lines.some((l) => l.toLowerCase().includes(q))),
      ),
    [q, category, klass],
  );

  const shownCommands = useMemo(
    () =>
      COMMANDS.filter(
        (c) =>
          (category === "" || c.category === category) &&
          (q === "" ||
            c.command.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q)),
      ),
    [q, category],
  );

  const categories = view === "macros" ? MACRO_CATEGORIES : COMMAND_CATEGORIES;

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">Macros</span>
        <span className="hint">
          Battle-tested socials — copy each line into an EQ social slot
          (EQ Button → right-click a social → edit). Community-sourced;
          Legends-only commands are noted in the tips.
        </span>
      </div>
      <div className="drops-controls">
        <div className="macro-view-toggle">
          <button
            className={`settings-tab${view === "macros" ? " active" : ""}`}
            onClick={() => {
              setView("macros");
              setCategory("");
            }}
          >
            Macros
          </button>
          <button
            className={`settings-tab${view === "commands" ? " active" : ""}`}
            onClick={() => {
              setView("commands");
              setCategory("");
            }}
          >
            Command reference
          </button>
        </div>
        <input
          type="search"
          placeholder={
            view === "macros"
              ? "Search macros… (name, text, description)"
              : "Search commands…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {view === "macros" && (
          <>
          <input
            className="macro-name-input"
            type="text"
            placeholder="Name for Tankname, Dragger, Leadername..."
            value={macroName}
            onChange={(e) => setMacroName(e.target.value)}
            title="Replaces common macro placeholders before copy/paste"
          />
          <select value={klass} onChange={(e) => setKlass(e.target.value)}>
            <option value="">All classes</option>
            {MACRO_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          </>
        )}
      </div>

      {view === "macros" ? (
        shownMacros.length === 0 ? (
          <Empty title="No macros match" body="Try clearing the filters." />
        ) : (
          <div className="macro-grid">
            {shownMacros.map((m) => (
              <MacroCard key={m.name} macro={m} macroName={macroName} />
            ))}
          </div>
        )
      ) : shownCommands.length === 0 ? (
        <Empty title="No commands match" body="Try clearing the filters." />
      ) : (
        <div className="cmd-table">
          <div className="cmd-row cmd-head" aria-hidden="true">
            <span>Command</span>
            <span>Syntax</span>
            <span>Category</span>
            <span>Description</span>
          </div>
          {shownCommands.map((c) => (
            <div className="cmd-row" key={c.command}>
              <code>{c.command}</code>
              <code className="cmd-syntax">{c.syntax}</code>
              <span className="hint">{c.category}</span>
              <span>
                {c.description}
                {c.source && (
                  <>
                    {" "}
                    <a href={c.source} target="_blank" rel="noreferrer">
                      source
                    </a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
