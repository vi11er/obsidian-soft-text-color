'use strict';

const { Plugin, addIcon } = require('obsidian');
const { ViewPlugin, Decoration } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

const SOFT_COLORS = [
  { id: 'soft-purple', name: 'Нежно-фиолетовый', hex: '#9b7ede' },
  { id: 'soft-pink',   name: 'Нежно-розовый',    hex: '#e06c9f' },
  { id: 'soft-green',  name: 'Зелёный',          hex: '#3fa36c' },
  { id: 'soft-yellow', name: 'Жёлтый',           hex: '#d9a441' },
  { id: 'soft-red',    name: 'Красный',          hex: '#d9534f' },
  { id: 'soft-cyan',   name: 'Голубой',          hex: '#3898c8' },
  { id: 'soft-blue',   name: 'Синий',            hex: '#4c74c9' },
];

// Matches <span ... style="...color: VALUE..." ...>INNER</span>
const SPAN_COLOR_REGEX = /(<span\b[^>]*?\bstyle\s*=\s*["'][^"']*?\bcolor\s*:\s*([^;"']+)[^"']*?["'][^>]*>)([\s\S]*?)(<\/span>)/gi;

function sanitizeColor(raw) {
  const c = String(raw || '').trim();
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|var\(--[a-zA-Z0-9_-]+\)|[a-zA-Z]{3,20})$/.test(c)) {
    return c;
  }
  return null;
}

function buildHiddenSpanExtension() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view) {
        const builder = new RangeSetBuilder();
        const doc = view.state.doc;
        const ops = [];

        for (const { from, to } of view.visibleRanges) {
          const text = doc.sliceString(from, to);
          SPAN_COLOR_REGEX.lastIndex = 0;
          let match;
          while ((match = SPAN_COLOR_REGEX.exec(text)) !== null) {
            const fullStart = from + match.index;
            const openTag = match[1];
            const rawColor = match[2];
            const innerText = match[3];
            const closeTag = match[4];

            const color = sanitizeColor(rawColor);
            if (!color) continue;

            const openEnd = fullStart + openTag.length;
            const closeStart = openEnd + innerText.length;
            const closeEnd = closeStart + closeTag.length;

            // Hide opening <span ...> completely
            ops.push({
              from: fullStart,
              to: openEnd,
              deco: Decoration.replace({}),
            });

            // Color the inner text directly in editor
            if (closeStart > openEnd) {
              ops.push({
                from: openEnd,
                to: closeStart,
                deco: Decoration.mark({
                  cls: 'stc-colored-text',
                  attributes: { style: `--stc-color: ${color}; color: ${color};` },
                }),
              });
            }

            // Hide closing </span> completely
            ops.push({
              from: closeStart,
              to: closeEnd,
              deco: Decoration.replace({}),
            });
          }
        }

        ops.sort((a, b) => a.from - b.from || a.to - b.to);
        for (const op of ops) {
          builder.add(op.from, op.to, op.deco);
        }
        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/**
 * Finds if [selFrom, selTo] is inside or tightly wrapped by an existing <span style="color:...">...</span>
 * and applies or clears the color cleanly without nested tags.
 */
function applyOrClearColorInEditor(editor, targetHex) {
  const fullText = editor.getValue();
  const fromPos = editor.getCursor('from');
  const toPos = editor.getCursor('to');
  let selFrom = editor.posToOffset(fromPos);
  let selTo = editor.posToOffset(toPos);

  // Check if selection/cursor is inside or adjacent to an existing color span
  SPAN_COLOR_REGEX.lastIndex = 0;
  let match;
  while ((match = SPAN_COLOR_REGEX.exec(fullText)) !== null) {
    const spanStart = match.index;
    const openEnd = spanStart + match[1].length;
    const closeStart = openEnd + match[3].length;
    const spanEnd = closeStart + match[4].length;

    // Case 1: User selected the exact visible text (or part/all with hidden tags)
    const coversWholeInner = selFrom <= openEnd && selTo >= closeStart && selFrom >= spanStart && selTo <= spanEnd;
    // Case 2: No text selected, cursor is simply inside a colored word/span
    const cursorInside = selFrom === selTo && selFrom >= spanStart && selTo <= spanEnd;

    if (coversWholeInner || cursorInside) {
      selFrom = spanStart;
      selTo = spanEnd;
      break;
    }
  }

  if (selFrom === selTo) {
    // Nothing selected and cursor not inside an existing color span: try selecting word under cursor
    const wordRange = editor.wordAt(fromPos);
    if (!wordRange) return;
    selFrom = editor.posToOffset(wordRange.from);
    selTo = editor.posToOffset(wordRange.to);
  }

  const rawSegment = fullText.slice(selFrom, selTo);
  // Strip any existing color spans inside the selected range to prevent nesting
  const strippedSegment = rawSegment.replace(SPAN_COLOR_REGEX, '$3');

  const replacement = targetHex
    ? `<span style="color: ${targetHex}">${strippedSegment}</span>`
    : strippedSegment;

  const replaceFrom = editor.offsetToPos(selFrom);
  const replaceTo = editor.offsetToPos(selTo);
  editor.replaceRange(replacement, replaceFrom, replaceTo);
}

module.exports = class SoftTextColorPlugin extends Plugin {
  async onload() {
    // Register colored circle icons for the context menu
    for (const c of SOFT_COLORS) {
      addIcon(
        `stc-dot-${c.id}`,
        `<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="38" fill="${c.hex}" stroke="currentColor" stroke-width="6" stroke-opacity="0.25"/></svg>`
      );
    }

    // Register CodeMirror 6 extension that hides <span style="color:..."> and </span> at all times
    this.registerEditorExtension(buildHiddenSpanExtension());

    // Add right-click context menu item with submenu
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        menu.addItem((item) => {
          item.setTitle('Цвет текста').setIcon('palette');

          if (typeof item.setSubmenu === 'function') {
            const sub = item.setSubmenu();
            for (const c of SOFT_COLORS) {
              sub.addItem((subItem) => {
                subItem
                  .setTitle(c.name)
                  .setIcon(`stc-dot-${c.id}`)
                  .onClick(() => {
                    applyOrClearColorInEditor(editor, c.hex);
                  });
              });
            }
            sub.addSeparator();
            sub.addItem((subItem) => {
              subItem
                .setTitle('Сбросить цвет')
                .setIcon('eraser')
                .onClick(() => {
                  applyOrClearColorInEditor(editor, null);
                });
            });
          } else {
            // Fallback if setSubmenu is not supported
            item.onClick(() => {
              applyOrClearColorInEditor(editor, SOFT_COLORS[0].hex);
            });
          }
        });
      })
    );

    // Also register keyboard-assignable commands for each color & reset
    for (const c of SOFT_COLORS) {
      this.addCommand({
        id: `set-color-${c.id}`,
        name: `Цвет текста: ${c.name}`,
        editorCallback: (editor) => applyOrClearColorInEditor(editor, c.hex),
      });
    }
    this.addCommand({
      id: 'clear-text-color',
      name: 'Цвет текста: Сбросить цвет',
      editorCallback: (editor) => applyOrClearColorInEditor(editor, null),
    });
  }
};
