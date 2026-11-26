// SPDX-License-Identifier: GPL-3.0-or-later
// The translation models in the Options panel: the ones that matter for the language books are translated into, and
// every one downloaded, each with what can be done with it.
import { t } from '../core/i18n.js';
import { languageName } from '../speech/engine-web.js';

const PIVOT = 'en';
const MB = 1024 * 1024;

/**
 * @param {{id: string, from: string, to: string, installed: string|null}[]} pairs
 * @param {string} target The language books are translated into.
 * @returns {object[]} To and from `target` through English first, then the others on disk.
 */
export function relevantPairs(pairs, target) {
  const first = pairs.filter(({ from, to }) => (from === PIVOT && to === target) || (from === target && to === PIVOT));
  const others = pairs.filter((pair) => pair.installed && !first.includes(pair));
  return [...first, ...others];
}

export const sizeText = (bytes) => `${Math.max(1, Math.round(bytes / MB))} MB`;

/**
 * @param {HTMLElement} host
 * @param {{pairs: object[], target: string, downloads: Record<string, number>}} view `downloads`: percent by pair.
 * @param {{onDownload: (id: string) => void, onCancel: (id: string) => void, onRemove: (id: string) => void}} handlers
 */
export function renderTranslationModels(host, { pairs, target, downloads }, { onDownload, onCancel, onRemove }) {
  const document = host.ownerDocument;
  const make = (tag, className, text) => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text !== undefined) made.textContent = text;
    return made;
  };
  const button = (text, run, kind = 'btn-secondary') => {
    const made = make('button', `btn ${kind}`, text);
    made.addEventListener('click', () => run());
    return made;
  };

  const row = (pair) => {
    const line = make('div', 'option translation-model');
    line.setAttribute('data-pair', pair.id);
    const percent = downloads[pair.id];
    const words = make('span', 'option-label');
    words.append(make('span', undefined, `${languageName(pair.from)} → ${languageName(pair.to)}`));
    const about = percent === undefined ? sizeText(pair.bytes) : `${sizeText(pair.bytes)} · ${percent}%`;
    words.append(make('span', 'option-hint', about));
    const actions = make('div', 'option-action');
    if (percent !== undefined) actions.append(button(t('translate.cancel'), () => onCancel(pair.id)));
    else if (!pair.installed) actions.append(button(t('translate.get'), () => onDownload(pair.id)));
    else {
      if (pair.update) actions.append(button(t('translate.update'), () => onDownload(pair.id)));
      actions.append(button(t('translate.remove'), () => onRemove(pair.id)));
    }
    line.append(words, actions);
    return line;
  };

  const title = make('h3', 'option-subgroup', t('translate.models'));
  const hint = make('p', 'option-hint', t('translate.modelsHint'));
  host.replaceChildren(title, hint, ...relevantPairs(pairs, target).map(row));
}
