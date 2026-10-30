import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

export function TextEditor({
  value,
  onChange,
  onSave,
  path,
  original,
  readOnly = false,
  label,
}: {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  path: string;
  original?: string;
  readOnly?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const save = useRef(onSave);
  save.current = onSave;
  const initial = useRef(value);
  const readonlyConfig = useRef(new Compartment());
  const readonlyValue = useRef(readOnly);
  readonlyValue.current = readOnly;
  useEffect(() => {
    if (!host.current) return;
    const language = path.toLowerCase().endsWith(".json")
      ? json()
      : /\.ya?ml$/i.test(path)
        ? yaml()
        : [];
    const view = new EditorView({
      parent: host.current,
      doc: initial.current,
      extensions: [
        basicSetup,
        EditorView.domEventHandlers({
          keydown(event) {
            if (
              (event.ctrlKey || event.metaKey) &&
              !event.altKey &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              save.current?.();
              return true;
            }
            return false;
          },
        }),
        language,
        EditorState.lineSeparator.of(
          initial.current.includes("\r\n") ? "\r\n" : "\n",
        ),
        readonlyConfig.current.of([
          EditorState.readOnly.of(readonlyValue.current),
          EditorView.editable.of(!readonlyValue.current),
        ]),
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) change.current?.(update.state.sliceDoc());
        }),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              backgroundColor: "var(--background)",
              color: "var(--foreground)",
              fontSize: "13px",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "ui-monospace, monospace",
            },
            ".cm-gutters": {
              backgroundColor: "var(--card)",
              color: "var(--muted-foreground)",
              borderColor: "var(--border)",
            },
            ".cm-activeLine,.cm-activeLineGutter": {
              backgroundColor: "var(--muted)",
            },
            ".cm-selectionBackground": {
              backgroundColor: "var(--accent) !important",
            },
            ".cm-cursor": { borderLeftColor: "var(--primary)" },
            ".cm-searchMatch": { backgroundColor: "var(--accent)" },
            ".cm-panels": {
              backgroundColor: "var(--card)",
              color: "var(--foreground)",
            },
          },
          { dark: true },
        ),
        ...(original === undefined
          ? []
          : unifiedMergeView({
              original,
              mergeControls: false,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: false,
              diffConfig: { scanLimit: 1000, timeout: 1000 },
            })),
      ],
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [path, original, label]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: readonlyConfig.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.sliceDoc() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
  }, [value]);
  return (
    <div
      ref={host}
      className="h-full min-h-64 overflow-hidden rounded-lg border"
    />
  );
}
