'use strict';

const { Plugin, addIcon } = require('obsidian');
const { EditorView, Decoration } = require('@codemirror/view');
const { StateField, RangeSetBuilder, EditorSelection, Prec } = require('@codemirror/state');

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

function buildSpanState(doc) {
  const decoBuilder = new RangeSetBuilder();
  const atomicBuilder = new RangeSetBuilder();
  const text = doc.toString();
  const decoOps = [];
  const atomicOps = [];

  SPAN_COLOR_REGEX.lastIndex = 0;
  let match;
  while ((match = SPAN_COLOR_REGEX.exec(text)) !== null) {
    const fullStart = match.index;
    const openTag = match[1];
    const rawColor = match[2];
    const innerText = match[3];
    const closeTag = match[4];

    const color = sanitizeColor(rawColor);
    if (!color) continue;

    const openEnd = fullStart + openTag.length;
    const closeStart = openEnd + innerText.length;
    const closeEnd = closeStart + closeTag.length;

    // Hide opening <span ...> completely and mark it atomic for seamless cursor navigation
    const hideOpen = Decoration.replace({});
    decoOps.push({ from: fullStart, to: openEnd, deco: hideOpen });
    atomicOps.push({ from: fullStart, to: openEnd, deco: hideOpen });

    // Color the inner text directly in editor
    if (closeStart > openEnd) {
      decoOps.push({
        from: openEnd,
        to: closeStart,
        deco: Decoration.mark({
          cls: 'stc-colored-text',
          attributes: { style: `--stc-color: ${color}; color: ${color};` },
        }),
      });
    }

    // Hide closing </span> completely and mark it atomic for seamless cursor navigation
    const hideClose = Decoration.replace({});
    decoOps.push({ from: closeStart, to: closeEnd, deco: hideClose });
    atomicOps.push({ from: closeStart, to: closeEnd, deco: hideClose });
  }

  decoOps.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const op of decoOps) {
    decoBuilder.add(op.from, op.to, op.deco);
  }

  atomicOps.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const op of atomicOps) {
    atomicBuilder.add(op.from, op.to, op.deco);
  }

  return {
    decorations: decoBuilder.finish(),
    atomicRanges: atomicBuilder.finish(),
  };
}

function findWordBoundsAt(text, pos, minBound, maxBound) {
  const wordChar = /[\p{L}\p{N}_]/u;
  const clamped = Math.max(minBound, Math.min(pos, maxBound));

  // Pick character at clamped or immediately before it
  let idx = clamped;
  if (idx >= maxBound || !wordChar.test(text[idx])) {
    if (idx > minBound && wordChar.test(text[idx - 1])) {
      idx -= 1;
    } else {
      return null;
    }
  }

  let start = idx;
  let end = idx + 1;
  while (start > minBound && wordChar.test(text[start - 1])) start--;
  while (end < maxBound && wordChar.test(text[end])) end++;
  return { start, end };
}

function getExactOffsetInSpanWidget(event, view, span, text) {
  const widgetRoot = event.target instanceof Element
    ? event.target.closest('.cm-html-embed, [contenteditable="false"]')
    : null;
  if (!widgetRoot || typeof document.caretRangeFromPoint !== 'function') {
    return null;
  }
  const range = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!range || !widgetRoot.contains(range.startContainer)) {
    return null;
  }
  const preRange = document.createRange();
  preRange.selectNodeContents(widgetRoot);
  preRange.setEnd(range.startContainer, range.startOffset);
  const offsetInVisible = preRange.toString().length;
  const candidate = span.openEnd + offsetInVisible;
  if (candidate >= span.openEnd && candidate <= span.closeStart) {
    return candidate;
  }
  return null;
}

function buildHiddenSpanExtension() {
  const spanStateField = StateField.define({
    create(state) {
      return buildSpanState(state.doc);
    },
    update(value, tr) {
      if (tr.docChanged) {
        return buildSpanState(tr.state.doc);
      }
      return value;
    },
    provide: (field) => [
      EditorView.decorations.from(field, (v) => v.decorations),
      EditorView.atomicRanges.from(field, (v) => v.atomicRanges),
    ],
  });

  // Override Obsidian's HTML widget double-click so double-clicking inside colored text
  // selects only the single word under the cursor, matching plain text behavior.
  const wordDblClickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.detail !== 2) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;

      const text = view.state.doc.toString();
      const spans = findAllColorSpans(text);
      const span = spans.find((s) => pos >= s.spanStart && pos <= s.spanEnd);
      if (!span) return false;

      const widgetPos = getExactOffsetInSpanWidget(event, view, span, text);
      const targetPos = widgetPos != null ? widgetPos : pos;
      const bounds = findWordBoundsAt(text, targetPos, span.openEnd, span.closeStart);
      if (!bounds) return false;

      event.preventDefault();
      view.dispatch({
        selection: EditorSelection.range(bounds.start, bounds.end),
      });
      return true;
    },
  });

  // Do NOT wrap spanStateField in Prec.highest: Obsidian's Live Preview replace widgets
  // conflict with Prec.highest(Decoration.replace) and can collapse inner text.
  return [spanStateField, Prec.highest(wordDblClickHandler)];
}

function findAllColorSpans(text) {
  const spans = [];
  SPAN_COLOR_REGEX.lastIndex = 0;
  let match;
  while ((match = SPAN_COLOR_REGEX.exec(text)) !== null) {
    const spanStart = match.index;
    const openEnd = spanStart + match[1].length;
    const closeStart = openEnd + match[3].length;
    const spanEnd = closeStart + match[4].length;
    spans.push({
      spanStart,
      openTag: match[1],
      openEnd,
      color: sanitizeColor(match[2]) || match[2].trim(),
      inner: match[3],
      closeStart,
      spanEnd,
    });
  }
  return spans;
}

function stripColorSpans(segment) {
  let out = segment;
  let prev;
  do {
    prev = out;
    out = out.replace(SPAN_COLOR_REGEX, '$3');
  } while (out !== prev);
  return out;
}

/**
 * Applies or clears color cleanly for cursor, partial selection inside a span,
 * full span selection, or multi-span/overlapping selection.
 */
function applyOrClearColorInEditor(editor, targetHex, clickCoords = null) {
  const fullText = editor.getValue();
  let fromPos = editor.getCursor('from');
  let toPos = editor.getCursor('to');
  let selFrom = editor.posToOffset(fromPos);
  let selTo = editor.posToOffset(toPos);

  // If no text is selected, prefer the exact position under the right-click mouse coordinates
  if (selFrom === selTo && clickCoords && editor.cm && typeof editor.cm.posAtCoords === 'function') {
    const mouseOffset = editor.cm.posAtCoords({ x: clickCoords.x, y: clickCoords.y });
    if (typeof mouseOffset === 'number' && mouseOffset >= 0 && mouseOffset <= fullText.length) {
      selFrom = mouseOffset;
      selTo = mouseOffset;
      fromPos = editor.offsetToPos(mouseOffset);
      toPos = fromPos;
    }
  }
  const spans = findAllColorSpans(fullText);

  // Case 1: Empty selection (cursor only)
  if (selFrom === selTo) {
    const inside = spans.find((s) => selFrom >= s.spanStart && selFrom <= s.spanEnd);
    if (inside) {
      const cleaned = stripColorSpans(inside.inner);
      const replacement = targetHex
        ? `<span style="color: ${targetHex}">${cleaned}</span>`
        : cleaned;
      editor.replaceRange(
        replacement,
        editor.offsetToPos(inside.spanStart),
        editor.offsetToPos(inside.spanEnd)
      );
      return;
    }
    const wordRange = editor.wordAt(fromPos);
    if (!wordRange) return;
    selFrom = editor.posToOffset(wordRange.from);
    selTo = editor.posToOffset(wordRange.to);
  }

  // Case 2: Selection is strictly inside a single colored span's inner text
  const enclosing = spans.find((s) => selFrom >= s.spanStart && selTo <= s.spanEnd);
  if (enclosing) {
    const innerSelFrom = Math.max(selFrom, enclosing.openEnd);
    const innerSelTo = Math.min(selTo, enclosing.closeStart);
    const before = fullText.slice(enclosing.openEnd, innerSelFrom);
    const middle = stripColorSpans(fullText.slice(innerSelFrom, innerSelTo));
    const after = fullText.slice(innerSelTo, enclosing.closeStart);

    // If user selected effectively the whole span (ignoring leading/trailing spaces)
    if (before.trim() === '' && after.trim() === '') {
      const wholeInner = stripColorSpans(enclosing.inner);
      const replacement = targetHex
        ? `<span style="color: ${targetHex}">${wholeInner}</span>`
        : wholeInner;
      editor.replaceRange(
        replacement,
        editor.offsetToPos(enclosing.spanStart),
        editor.offsetToPos(enclosing.spanEnd)
      );
      return;
    }

    // Split the span cleanly around the selected substring
    let replacement = '';
    if (before) replacement += `<span style="color: ${enclosing.color}">${before}</span>`;
    replacement += targetHex ? `<span style="color: ${targetHex}">${middle}</span>` : middle;
    if (after) replacement += `<span style="color: ${enclosing.color}">${after}</span>`;

    editor.replaceRange(
      replacement,
      editor.offsetToPos(enclosing.spanStart),
      editor.offsetToPos(enclosing.spanEnd)
    );
    return;
  }

  // Case 3: Selection overlaps one or more spans (e.g. includes spaces or crosses span boundaries)
  let effFrom = selFrom;
  let effTo = selTo;
  for (const s of spans) {
    if (s.spanStart < effTo && s.spanEnd > effFrom) {
      if (effFrom < s.openEnd || effFrom > s.spanStart && effFrom < s.openEnd) {
        effFrom = Math.min(effFrom, s.spanStart);
      }
      if (effTo > s.closeStart || (effFrom <= s.openEnd && effTo >= s.closeStart)) {
        effTo = Math.max(effTo, s.spanEnd);
      }
      // If selection starts inside a span's text and exits past its end, include the whole span
      if (effFrom > s.spanStart && effFrom < s.spanEnd && effTo >= s.spanEnd) {
        effFrom = Math.min(effFrom, s.spanStart);
      }
      // If selection starts before a span and ends inside its text, include the whole span
      if (effFrom <= s.spanStart && effTo > s.spanStart && effTo < s.spanEnd) {
        effTo = Math.max(effTo, s.spanEnd);
      }
    }
  }

  const rawSegment = fullText.slice(effFrom, effTo);
  const strippedSegment = stripColorSpans(rawSegment);

  const replacement = targetHex
    ? `<span style="color: ${targetHex}">${strippedSegment}</span>`
    : strippedSegment;

  editor.replaceRange(
    replacement,
    editor.offsetToPos(effFrom),
    editor.offsetToPos(effTo)
  );
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

    // Register CodeMirror 6 StateField that hides <span style="color:..."> and </span> reliably
    this.registerEditorExtension(buildHiddenSpanExtension());

    // Track exact right-click coordinates so un-selected right-clicks target the word under mouse
    this.lastContextCoords = null;
    this.registerDomEvent(document, 'contextmenu', (evt) => {
      this.lastContextCoords = { x: evt.clientX, y: evt.clientY, ts: Date.now() };
    });

    const getRecentCoords = () => {
      if (this.lastContextCoords && Date.now() - this.lastContextCoords.ts < 10000) {
        return this.lastContextCoords;
      }
      return null;
    };

    // Add right-click context menu item with submenu
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const coordsSnapshot = getRecentCoords();
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
                    applyOrClearColorInEditor(editor, c.hex, coordsSnapshot);
                  });
              });
            }
            sub.addSeparator();
            sub.addItem((subItem) => {
              subItem
                .setTitle('Сбросить цвет')
                .setIcon('eraser')
                .onClick(() => {
                  applyOrClearColorInEditor(editor, null, coordsSnapshot);
                });
            });
          } else {
            // Fallback if setSubmenu is not supported
            item.onClick(() => {
              applyOrClearColorInEditor(editor, SOFT_COLORS[0].hex, coordsSnapshot);
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
