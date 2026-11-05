// SPDX-License-Identifier: GPL-3.0-or-later
// Drawn here rather than taken from a Windows icon font: the two versions of Windows have different fonts.

const SVG = 'http://www.w3.org/2000/svg';
const SPEAKER_WAVES = '<path d="M10.6 5.6a3.3 3.3 0 0 1 0 4.8M12.4 3.9a5.8 5.8 0 0 1 0 8.2"/>';
const DOT = 'fill="currentColor" stroke="none"';

// Each one: its box, the width of its line, what it draws.
const ICONS = {
  add: ['0 0 14 14', 1.5, '<path d="M7 2.5v9M2.5 7h9"/>'],
  alert: ['0 0 16 16', 1.4, '<path d="M8 2.2 14.3 13H1.7z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.3" r=".5" fill="currentColor"/>'],
  back: ['0 0 14 14', 1.6, '<path d="M8.5 3 4.5 7l4 4"/>'],
  bookmark: ['0 0 16 16', 1.4, '<path d="M4.5 2.5h7v11L8 10.9l-3.5 2.6z"/>'],
  check: ['0 0 16 16', 1.4, '<path d="M3 8.5 6.3 11.6 13 4.6"/>'],
  chevron: ['0 0 12 12', 1.5, '<path d="M3 4.5 6 7.5l3-3"/>'],
  clock: ['0 0 16 16', 1.4, '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>'],
  close: ['0 0 10 10', 1.4, '<path d="M2 2l6 6M8 2 2 8"/>'],
  contents: ['0 0 16 16', 1.4, `<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="3" cy="4" r=".9" ${DOT}/><circle cx="3" cy="8" r=".9" ${DOT}/><circle cx="3" cy="12" r=".9" ${DOT}/>`],
  copy: ['0 0 16 16', 1.4, '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'],
  doc: ['0 0 22 22', 1.5, '<path d="M5 2.8h8l4 4v12.4H5z"/><path d="M13 2.8v4h4M8.5 12.5h5M8.5 15.5h3"/>'],
  down: ['0 0 16 16', 1.6, '<path d="M8 3v9.5M4 9l4 4 4-4"/>'],
  faster: ['0 0 12 12', 1.5, '<path d="M2.5 6h7M6 2.5v7"/>'],
  folder: ['0 0 16 16', 1.4, '<path d="M1.8 12.8V3.3h4.3l1.5 1.6h5.6v1.8"/><path d="M1.8 12.8 4 7h10.4l-2.2 5.8z"/>'],
  forward: ['0 0 14 14', 1.6, '<path d="M5.5 3l4 4-4 4"/>'],
  info: ['0 0 16 16', 1.4, '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".5" fill="currentColor"/>'],
  keyboard: ['0 0 16 16', 1.4, '<rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 7h.01M6.7 7h.01M9.3 7h.01M12 7h.01M5.5 10h5"/>'],
  lock: ['0 0 22 22', 1.5, '<rect x="4" y="9.5" width="14" height="9" rx="2"/><path d="M7 9.5V7a4 4 0 0 1 8 0v2.5"/><circle cx="11" cy="14" r="1" fill="currentColor"/>'],
  more: ['0 0 16 16', 1.4, '<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>'],
  mute: ['0 0 16 16', 1.4, '<path d="M2.5 6.2h2.3L8 3.4v9.2l-3.2-2.8H2.5z"/><path d="M10.5 6l4 4M14.5 6l-4 4"/>'],
  next: ['0 0 16 16', 1.4, `<rect x="11.3" y="3" width="1.7" height="10" rx=".8" ${DOT}/><path d="M3 3.3v9.4L10 8z" ${DOT}/>`],
  pause: ['0 0 16 16', 1.4, `<rect x="4" y="3" width="2.6" height="10" rx="1" ${DOT}/><rect x="9.4" y="3" width="2.6" height="10" rx="1" ${DOT}/>`],
  play: ['0 0 16 16', 1.4, `<path d="M5 2.8v10.4L13.2 8z" ${DOT}/>`],
  prev: ['0 0 16 16', 1.4, `<rect x="3" y="3" width="1.7" height="10" rx=".8" ${DOT}/><path d="M13 3.3v9.4L6 8z" ${DOT}/>`],
  sliders: ['0 0 16 16', 1.4, '<path d="M2.5 4.5h11M2.5 11.5h11"/><circle cx="10.5" cy="4.5" r="1.8" fill="var(--icon-fill, var(--bg))"/><circle cx="5.5" cy="11.5" r="1.8" fill="var(--icon-fill, var(--bg))"/>'],
  slower: ['0 0 12 12', 1.5, '<path d="M2.5 6h7"/>'],
  speaker: ['0 0 16 16', 1.4, `<path d="M2.5 6.2h2.3L8 3.4v9.2l-3.2-2.8H2.5z"/>${SPEAKER_WAVES}`],
  speaking: ['0 0 16 16', 1.4, `<path d="M2.5 6.2h2.3L8 3.4v9.2l-3.2-2.8H2.5z" ${DOT}/>${SPEAKER_WAVES}`],
  stop: ['0 0 14 14', 1.4, `<rect x="2.5" y="2.5" width="9" height="9" rx="1.8" ${DOT}/>`],
};

/**
 * @param {Document} doc
 * @param {keyof typeof ICONS} name
 * @param {number} [size] In pixels.
 * @returns {SVGElement} Decorative: what it means is said by the label of its control.
 */
export function icon(doc, name, size = 16) {
  const [box, width, drawing] = ICONS[name];
  const svg = doc.createElementNS(SVG, 'svg');
  const attributes = {
    class: 'icon',
    width: size,
    height: size,
    viewBox: box,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': width,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  Object.entries(attributes).forEach(([name_, value]) => svg.setAttribute(name_, String(value)));
  svg.innerHTML = drawing;
  return svg;
}

/**
 * A button with an icon names itself in a tooltip, and in the tooltip also says its key.
 * @param {Element} control
 * @param {string} text
 * @param {string} [keys] As people write it: `Ctrl+D`.
 */
export function named(control, text, keys) {
  control.setAttribute('aria-label', text);
  control.setAttribute('title', keys ? `${text} (${keys})` : text);
  if (keys) control.setAttribute('aria-keyshortcuts', keys);
}
