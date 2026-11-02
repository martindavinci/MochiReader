// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectLang } from '../app/speech/lang.js';

// The author's vault, used when it is there: real text, too personal to copy into the fixtures.
const DAILY_DIR = 'C:/Users/marty/Documents/git/_MDV/LeonardoTechTips/00_Daily/Daily';

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

const FOREIGN_PROSE = {
  french: [
    'Le gouvernement a annoncé une nouvelle loi sur la protection des données personnelles dans toute la France et les citoyens de la ville sont contents',
    "Il faisait déjà nuit quand elle est rentrée à la maison, et personne ne l'attendait plus depuis longtemps.",
    "La protection de la nature est une question importante pour les habitants de la région qui vivent à la campagne.",
    "J'ai une maison avec un jardin et ma fille mange une pomme.",
    "Elle a pris le train pour Paris avec son frère, mais il ne se souvient plus de la gare où ils sont descendus.",
  ],
  spanish: [
    'El gobierno ha anunciado una nueva ley sobre la protección de los datos personales en todo el país y los ciudadanos están contentos con la decisión.',
    'La casa de mi abuela está en un pueblo pequeño cerca de la costa, y todos los veranos vamos a pasar unas semanas con ella.',
    'No sé si la gente de la ciudad se ha dado cuenta de que la vida es más tranquila en el campo que en la capital.',
    'Me gusta la música y tengo una guitarra con cuerdas nuevas.',
    'Una mujer con una maleta entró en la estación y preguntó por el tren que va a Madrid.',
  ],
  portuguese: [
    'O governo anunciou uma nova lei sobre a proteção dos dados pessoais em todo o país e os cidadãos da cidade estão contentes com a decisão.',
    'A casa da minha avó fica numa pequena aldeia perto da costa, e todos os verões passamos lá algumas semanas com ela.',
    'Não sei se as pessoas da cidade perceberam que a vida é mais tranquila no campo do que na capital.',
    'Eu tenho uma casa com um jardim. A menina come a maçã e bebe o sumo.',
    'Ela disse que o filho não vai à escola porque está doente e que o médico chega da cidade amanhã.',
  ],
  german: [
    'Die Regierung hat ein neues Gesetz zum Schutz der persönlichen Daten angekündigt, und die Bürger der Stadt sind damit sehr zufrieden.',
    'Es war schon spät, als er nach Hause kam, und an der Tür war niemand, der auf ihn gewartet hatte.',
  ],
  danish: [
    'Regeringen har fremlagt en ny lov om beskyttelse af personoplysninger, og borgerne i byen er meget tilfredse med at det er sket for dem.',
  ],
  dutch: [
    'De regering heeft een nieuwe wet aangekondigd over de bescherming van persoonsgegevens en de inwoners van de stad zijn daar erg blij mee.',
  ],
  catalan: [
    'El govern ha anunciat una nova llei sobre la protecció de les dades personals a tot el país i els ciutadans estan contents amb la decisió.',
  ],
  latin: [
    'Gallia est omnis divisa in partes tres, quarum unam incolunt Belgae, aliam Aquitani, tertiam qui ipsorum lingua Celtae appellantur.',
  ],
  romanian: [
    'Guvernul a anunțat o nouă lege privind protecția datelor personale în toată țara, iar cetățenii din oraș sunt foarte mulțumiți de această decizie.',
  ],
};

const ITALIAN_PROSE = [
  'Il governo ha annunciato una nuova legge sulla protezione dei dati personali in tutta Italia e i cittadini della città sono contenti.',
  "La casa di mia nonna è in un piccolo paese vicino alla costa, e ogni estate ci passiamo qualche settimana con lei.",
  "Non so se la gente della città si è accorta che la vita in campagna è più tranquilla.",
  'Figma spiega come ha post-addestrato un modello specializzato, mostrando che su task mirati i modelli possono competere con quelli frontier.',
  'La pasta con il pesto è buona',
];

const ENGLISH_PROSE = [
  'The government has announced a new law on the protection of personal data across the country and the citizens of the city are happy.',
  'My grandmother lives in a small village near the coast, and every summer we spend a few weeks there with her.',
  'I do not know if the people in town have noticed that life in the country is quieter.',
  'As a result, it was on the table at the end of the day when he came back with an answer.',
];

for (const [language, samples] of Object.entries(FOREIGN_PROSE)) {
  test(`${language} prose is neither Italian nor English`, () => {
    for (const sample of samples) assert.equal(detectLang(sample), null, sample);
  });
}

test('ordinary Italian and English prose are still recognized', () => {
  for (const sample of ITALIAN_PROSE) assert.equal(detectLang(sample), 'it', sample);
  for (const sample of ENGLISH_PROSE) assert.equal(detectLang(sample), 'en', sample);
});

test('terse technical notes still count as their language', () => {
  const note = `Stack: Kotlin for the app, Compose for screens, Hilt for injection. One module per app.
    Build: Gradle, AGP, KSP. Layout: one activity, three screens, state in a data class.
    Files: split above two hundred lines. Delete dead code. Previews on every screen.
    Strings live in resources. Named constants, no magic numbers. Catalog for dependencies.`;
  assert.equal(detectLang(note), 'en');
});

test('addresses do not count as words', () => {
  const line = 'La casa di mia nonna è in un piccolo paese vicino alla costa https://example.com/the-end-of-it-and-the-rest-of-this ';
  assert.equal(detectLang(line), 'it');
});

test('a real daily is recognized', { skip: !existsSync(DAILY_DIR) && 'the vault is not on this machine' }, () => {
  assert.equal(detectLang(readFileSync(join(DAILY_DIR, '2026-10-30.md'), 'utf8')), 'it');
  assert.equal(detectLang(readFileSync(join(DAILY_DIR, '2026-10-30-en.md'), 'utf8')), 'en');
});
