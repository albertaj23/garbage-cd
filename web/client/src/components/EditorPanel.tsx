import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { java } from "@codemirror/lang-java";
import { StateEffect, StateField, RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export interface EditorDiagnostic {
  line: number;
  severity: "error" | "warning" | "note";
}

export interface EditorCommand {
  seq: number;
  kind: "highlight" | "jump";
  start: number;
  end: number;
}

const setHighlight = StateEffect.define<{ start: number; end: number } | null>();
const setDiagnostics = StateEffect.define<EditorDiagnostic[]>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setHighlight)) {
        next =
          effect.value && effect.value.end > effect.value.start
            ? Decoration.set([Decoration.mark({ class: "cm-span" }).range(effect.value.start, effect.value.end)])
            : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

class DiagnosticMarker extends GutterMarker {
  constructor(readonly severity: string) {
    super();
  }
  toDOM() {
    const element = document.createElement("span");
    element.className = `cm-diag-marker cm-diag-${this.severity}`;
    element.textContent = this.severity === "error" ? "●" : "▲";
    element.title = this.severity;
    return element;
  }
}

const diagnosticsField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnostics)) {
        const doc = transaction.state.doc;
        const ranges = effect.value
          .filter((item) => item.line >= 1 && item.line <= doc.lines)
          .sort((a, b) => a.line - b.line)
          .map((item) => new DiagnosticMarker(item.severity).range(doc.line(item.line).from));
        return RangeSet.of(ranges, true);
      }
    }
    return value.map(transaction.changes);
  }
});

export function EditorPanel({
  source,
  language,
  diagnostics,
  command,
  readOnly,
  onChange
}: {
  source: string;
  language: "java" | "gcd-toy";
  diagnostics: EditorDiagnostic[];
  command: EditorCommand | null;
  readOnly: boolean;
  onChange: (source: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      doc: source,
      extensions: [
        lineNumbers(),
        gutter({
          class: "cm-diag-gutter",
          markers: (v) => v.state.field(diagnosticsField)
        }),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        language === "java" ? java() : [],
        highlightField,
        diagnosticsField,
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        })
      ]
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [language, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== source) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
    }
  }, [source, language, readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: setDiagnostics.of(diagnostics) });
  }, [diagnostics, source, language, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !command) return;
    const length = editor.state.doc.length;
    const start = Math.min(Math.max(command.start, 0), length);
    const end = Math.min(Math.max(command.end, start), length);
    editor.dispatch({
      effects: [setHighlight.of(command.kind === "highlight" ? { start, end } : null), EditorView.scrollIntoView(start, { y: "center" })],
      selection: command.kind === "jump" ? { anchor: start } : undefined
    });
    if (command.kind === "jump") editor.focus();
  }, [command]);

  return <div className="editor" ref={host} data-testid="editor" />;
}
