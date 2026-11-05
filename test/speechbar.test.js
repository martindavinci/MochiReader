// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { setLang } from '../app/core/i18n.js';
import en from '../app/lang/en.js';
import it from '../app/lang/it.js';
import { createSpeechBar } from '../app/ui/speechbar.js';

const PAGE = '<!doctype html><html><body><main id="panes"></main><aside id="panel"></aside></body></html>';

const VIEW = {
  name: 'a.md',
  playing: true,
  rate: 1.3,
  voices: [{ id: 'elsa', name: 'Microsoft Elsa - Italian (Italy)' }, { id: 'cosimo', name: 'Microsoft Cosimo - Italian (Italy)' }],
  voiceId: 'cosimo',
  following: true,
};

function setup() {
  const { document, window } = parseHTML(PAGE);
  globalThis.document = document;
  const commands = [];
  const voices = [];
  const bar = createSpeechBar({ onCommand: (action) => commands.push(action), onVoice: (id) => voices.push(id) });
  const element = () => document.getElementById('speechbar');
  const click = (action) => element().querySelector(`[data-action="${action}"]`).dispatchEvent(new window.Event('click'));
  return { bar, document, window, commands, voices, element, click };
}

test('the bar stays out of the page until there is a reading to show', () => {
  const { bar, element, document } = setup();
  assert.equal(element().hidden, true);
  bar.show(VIEW);
  assert.equal(element().hidden, false);
  assert.equal(document.getElementById('panes').nextElementSibling, element());
  bar.hide();
  assert.equal(element().hidden, true);
});

test('it says which file is being read and how fast', () => {
  setLang('en');
  const { bar, element } = setup();
  bar.show(VIEW);
  assert.equal(element().querySelector('.speech-name').textContent, 'a.md');
  assert.equal(element().querySelector('.speech-status').textContent, en['speech.reading']);
  assert.equal(element().querySelector('.speech-rate').textContent, '1.3×');
});

test('every button does its action and says what it is in the language of the interface', () => {
  const { bar, element, click, commands } = setup();
  setLang('it');
  bar.show(VIEW);
  assert.equal(element().querySelector('[data-action="speech.toggle"]').getAttribute('aria-label'), it['speech.pause']);
  assert.equal(element().querySelector('[data-action="speech.stop"]').getAttribute('title'), it['speech.stop']);
  setLang('en');
  bar.show(VIEW);
  assert.equal(element().querySelector('[data-action="speech.stop"]').getAttribute('title'), en['speech.stop']);
  for (const action of ['speech.prevSentence', 'speech.toggle', 'speech.nextSentence', 'speech.slower', 'speech.faster', 'speech.stop']) {
    click(action);
    assert.equal(commands.at(-1), action);
  }
});

test('the main button says resume in a pause', () => {
  setLang('en');
  const { bar, element } = setup();
  bar.show({ ...VIEW, playing: false });
  assert.equal(element().querySelector('[data-action="speech.toggle"]').getAttribute('aria-label'), en['speech.resume']);
});

test('follow appears only once the text has stopped following', () => {
  setLang('en');
  const { bar, element, click, commands } = setup();
  bar.show(VIEW);
  assert.equal(element().querySelector('[data-action="speech.follow"]').hidden, true);
  bar.show({ ...VIEW, following: false });
  const follow = element().querySelector('[data-action="speech.follow"]');
  assert.equal(follow.hidden, false);
  assert.equal(follow.textContent, en['speech.follow']);
  click('speech.follow');
  assert.equal(commands.at(-1), 'speech.follow');
});

test('the voices of the language are offered, the current one selected, and a choice is told', () => {
  const { bar, element, voices, window } = setup();
  bar.show(VIEW);
  const select = element().querySelector('select');
  assert.deepEqual([...select.querySelectorAll('option')].map((option) => option.getAttribute('value')), ['elsa', 'cosimo']);
  assert.equal(select.querySelector('option[selected]').getAttribute('value'), 'cosimo');
  select.querySelectorAll('option').forEach((option) => option.toggleAttribute('selected', option.getAttribute('value') === 'elsa'));
  select.dispatchEvent(new window.Event('change'));
  assert.deepEqual(voices, ['elsa']);
});

test('a press on a button leaves the focus on the text, or the arrows would stay with the button', () => {
  const { bar, element, document, window } = setup();
  bar.show(VIEW);
  const button = element().querySelector('[data-action="speech.toggle"]');
  const event = new window.Event('mousedown', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  const onSelect = new window.Event('mousedown', { bubbles: true, cancelable: true });
  element().querySelector('select').dispatchEvent(onSelect);
  assert.equal(onSelect.defaultPrevented, false);
  assert.ok(document.getElementById('speechbar'));
});

test('in a pause and from another tab the bar says so, and offers the way to the tab being read', () => {
  setLang('en');
  const { bar, element, commands, click } = setup();
  bar.show({ ...VIEW, playing: false });
  assert.equal(element().querySelector('.speech-status').textContent, en['speech.paused']);
  assert.equal(element().querySelector('.speech-go').hidden, true);
  bar.show({ ...VIEW, elsewhere: true });
  assert.equal(element().querySelector('.speech-status').textContent, en['speech.elsewhere']);
  assert.equal(element().querySelector('.speech-go').hidden, false);
  click('speech.goToTab');
  assert.deepEqual(commands, ['speech.goToTab']);
});

test('a voice chosen with the mouse leaves the keys to the text; with the keyboard the list keeps them', () => {
  const { bar, element, window } = setup();
  bar.show(VIEW);
  const select = element().querySelector('select');
  let blurs = 0;
  select.blur = () => {
    blurs += 1;
  };
  select.dispatchEvent(new window.Event('change'));
  assert.equal(blurs, 0);
  select.dispatchEvent(new window.Event('mousedown'));
  select.dispatchEvent(new window.Event('change'));
  assert.equal(blurs, 1);
  select.dispatchEvent(new window.Event('change'));
  assert.equal(blurs, 1);
});

