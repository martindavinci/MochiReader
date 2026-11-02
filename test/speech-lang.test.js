// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLang } from '../app/speech/lang.js';

test('lang detects it and en, and refuses too little text', () => {
  assert.equal(detectLang('Il gatto dorme sul divano e non vuole uscire di casa.'), 'it');
  assert.equal(detectLang('The cat sleeps on the sofa and does not want to leave the house.'), 'en');
  assert.equal(detectLang('ok'), null);
  assert.equal(detectLang(''), null);
});

test('Italian with English terms stays Italian', () => {
  assert.equal(
    detectLang('Mistral rilascia i pesi di Mistral Large 4, modello per deployment self-hosted e cybersecurity, con prestazioni open-weight al top nel coding agentico.'),
    'it',
  );
});

test('text with no common words of either language is refused', () => {
  assert.equal(detectLang('Der Hund schläft heute lange draußen unter Bäumen'), null);
});

test('a tie is refused', () => {
  assert.equal(detectLang('the cat il gatto of mice di topi'), null);
});
