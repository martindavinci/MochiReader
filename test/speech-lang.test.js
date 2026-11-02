// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectLang, parseLangTag } from '../app/speech/lang.js';
import { TRIGRAM_PROFILES } from '../app/speech/lang-profiles.js';

// The author's vault, used when it is there: real text, too personal to copy into the fixtures.
const DAILY_DIR = 'C:/Users/marty/Documents/git/_MDV/LeonardoTechTips/00_Daily/Daily';
const VAULT_NOTES = 'C:/Users/marty/Documents/git/_MDV/LeonardoTechTips/20_Projects/Lunaris Tools';
const TRIGRAMS_PER_PROFILE = 400;

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

test('short sentences of Romance languages do not pass for Italian', () => {
  for (const sample of [
    'Ce nom le fit tressaillir comme si un éclair lui eût passé devant la face.',
    'Le Flamand resta «tout bête», comme il disait lui-même quelque temps après.',
    'Querría saber, cabeza, si mi marido me quiere bien, o no.',
    'E quando fechou sobre mim a portinhola, gravemente.',
    'Si la casa es grande, me la quedo.',
    'Si le roi le sait, le peuple se tait.',
    'Si la casa és gran, me la quedo per a mi.',
  ]) {
    assert.equal(detectLang(sample), null, sample);
  }
});

test('Latin does not pass for Italian, however long', () => {
  for (const sample of [
    'His Caesar ita respondit: eo sibi minus dubitationis dari, quod eas res quas legati Helvetii commemorassent memoria teneret.',
    'Ubi vero moveri et adpropinquare muris viderunt, nova atque inusitata specie commoti legatos ad Caesarem de pace miserunt.',
    'id iis eripi quis pati posset? Postulavit deinde eadem quae legatis in mandatis dederat: ne aut Haeduis aut eorum sociis bellum inferret, obsides redderet, si id facere non posset, Germanorum tamen neminem ultra Rhenum transire pateretur.',
  ]) {
    assert.equal(detectLang(sample), null, sample);
  }
});

test('Germanic prose does not pass for English on the words they share', () => {
  for (const sample of [
    'Lang, of juister gezegd _veel_, had ik nagedacht voor ik daartoe besloot.',
    'Ich will was ich kann und was ich will.',
    'Ek is in die huis en my ma was by my.',
    'Hals will ich fliegen, An seinem Busen liegen!',
  ]) {
    assert.equal(detectLang(sample), null, sample);
  }
});

test('frontmatter and inline code are not words of the text', () => {
  const note = '---\ntitle: The art of the deal\ntags: [it, the, of]\nlang: it\n---\nIl gatto dorme sul divano e la casa è grande.';
  assert.equal(detectLang(note), 'it');
  assert.equal(detectLang(note.replaceAll('\n', '\r\n')), 'it');
  assert.equal(detectLang('---\ntitolo: il gatto e la casa\n...\nThe house is in a small town on the coast.'), 'en');
  assert.equal(detectLang('Usa `the of and to that this these those is are was` per la lista.'), 'it');
  assert.equal(detectLang('Usa ``the `of` and to that this these those is are`` per la lista.'), 'it');
  assert.equal(detectLang('---\nThe house is in a small town on the coast and it was late.'), 'en', 'a rule that closes nothing is text');
  assert.equal(detectLang('Scrivi `il gatto\nThe house is in a small town on the coast and it was late.'), 'en', 'a tick that closes nothing is text');
});

test('short notes that are mostly names keep their language', () => {
  for (const sample of [
    'Nvidia presenta nuovi chip per data center: prezzi in aumento del 20%.',
    'Scarica Python, installa pip, lancia lo script.',
    'ZeroPulse: piattaforma C2 basata su Cloudflare Tunnel.',
    'Apple esplora un secondo iPhone foldable in stile clamshell oltre al modello “book”.',
    'Qash raccoglie $1,5M per neobank LATAM basata su stablecoin.',
  ]) {
    assert.equal(detectLang(sample), 'it', sample);
  }
  for (const sample of [
    'OpenAI releases new model, Google responds with Gemini.',
    'Federal Reserve survey confirms cash remains third most-used payment method in USA.',
    'Persistent XSS in pretalx allows account takeover of conference organizers.',
  ]) {
    assert.equal(detectLang(sample), 'en', sample);
  }
});

test('terse Italian lists of a real note keep their language', () => {
  const note = `Strategia monetizzazione
- Banner solo schermate secondarie, mai su camera principale
- Interstitial dopo azione completata, massimo uno ogni tre azioni
- Nessun annuncio nella prima sessione utente
- Rewarded: un video vale dieci esportazioni Pro oppure un'ora Pro
- Acquisto unico Rimuovi Annunci, niente abbonamenti
- Prezzo consigliato tra due e quattro euro, sconto al lancio`;
  assert.equal(detectLang(note), 'it');
});

test('real notes of terse lists and foreign terms keep their language', { skip: !existsSync(VAULT_NOTES) && 'the vault is not on this machine' }, () => {
  for (const note of ['Monetization.md', 'Apps List.md', 'Task List - Lunaris PDF Tools.md']) {
    assert.equal(detectLang(readFileSync(join(VAULT_NOTES, note), 'utf8')), 'it', note);
  }
});

test('stray letters and words of the language itself are no rival', () => {
  assert.equal(detectLang('Crescono i consigli di sicurezza personale: niente crypto “a casa”, multisig e ritardi di prelievo.'), 'it');
  assert.equal(detectLang('Metodo per trasformare osservazioni d’interfaccia in insight UX azionabili.'), 'it');
  assert.equal(detectLang('MoonPay acquires DFlow, a Solana trading infrastructure, for $100 million in stock.'), 'en');
  assert.equal(detectLang('Me gusta la música y tengo una guitarra con cuerdas nuevas.'), null, 'a word of one letter is still a word');
});

test('languages that write like Italian or English are recognized by their letters', () => {
  for (const sample of [
    'Una noieta tota bonica saltironejava entre ells. La mare la mirava.',
    'Comprench la meva falta. Si vostè hagués sigut aquí, Deu meu.',
    'Hade vi inte det där fjället i väster, när vi gick ned?',
    'Vi kysser dine Gaver, vi signer din Aand, imens der drypper Taarer paa Skatten i vor Haand.',
    'Doi lei, doi zmei, doi bălauri și doi năsdrăvani se puseră pază la punte.',
    'Mama mea este foarte buna si ii place sa manance la masa cu toata familia.',
    'Iom post iom la novulo pli kutimis kaj la vivmaniero ekplaĉis al li.',
    'Wszystko mi sprzyjało; postanawiałem skorzystać z okoliczności i dziś jeszcze tę tajemnicę wykryć.',
    'Proč jsi tedy všeho nechal? ptal se udivený. Měl bys si hledati místo.',
    'Cwyd, cwyd ehedydd, cwyd, O le i le ar aden lwyd, Yn uwch, yn uwch o hyd.',
    'Niin, sepä se juuri piti meidän voittomme vähäisenä. Me yrittelimme järjestymistä.',
    'Escoita, sinto pasos, e asoma seica un bulto, non fala se é difunto.',
    'Ang bata ay kumain ng kanin at uminom ng tubig sa bahay.',
    'Die regering het nuwe wet aangekondig oor die beskerming van persoonlike data in die hele land.',
  ]) {
    assert.equal(detectLang(sample), null, sample);
  }
});

test('every profile holds as many different trigrams', () => {
  for (const [lang, trigrams] of Object.entries(TRIGRAM_PROFILES)) {
    const list = trigrams.split(/\s+/);
    assert.equal(list.length, TRIGRAMS_PER_PROFILE, lang);
    assert.equal(new Set(list).size, list.length, lang);
    assert.ok(list.every((trigram) => [...trigram].length === 3 || trigram.length === 3), lang);
  }
});

test('whatever is not a string has no language', () => {
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(detectLang(value), null, String(value));
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

test('language tags reduce to a two-letter language and a region', () => {
  const cases = {
    it: ['it', null, 'it'],
    ita: ['it', null, 'it'],
    ITA: ['it', null, 'it'],
    eng: ['en', null, 'en'],
    fre: ['fr', null, 'fr'],
    fra: ['fr', null, 'fr'],
    it_IT: ['it', 'IT', 'it-IT'],
    'IT-it': ['it', 'IT', 'it-IT'],
    'en-GB': ['en', 'GB', 'en-GB'],
    ' en-gb ': ['en', 'GB', 'en-GB'],
    'zh-Hant-TW': ['zh', 'TW', 'zh-TW'],
    'es-419': ['es', '419', 'es-419'],
    no: ['nb', null, 'nb'],
    nn: ['nb', null, 'nb'],
    cmn: ['zh', null, 'zh'],
    yue: ['zh', 'HK', 'zh-HK'],
    'zh-yue': ['zh', 'HK', 'zh-HK'],
    'yue-Hant': ['zh', 'HK', 'zh-HK'],
    'zh-Hant': ['zh', 'TW', 'zh-TW'],
    'zh-Hans': ['zh', 'CN', 'zh-CN'],
    'zh-Hant-HK': ['zh', 'HK', 'zh-HK'],
    'en-UK': ['en', 'GB', 'en-GB'],
    en_uk: ['en', 'GB', 'en-GB'],
    Italian: ['it', null, 'it'],
    italiano: ['it', null, 'it'],
    'it,en': ['it', null, 'it'],
    'en-GB;it': ['en', 'GB', 'en-GB'],
    'it_IT.UTF-8': ['it', 'IT', 'it-IT'],
    'en-u-ca-gregory': ['en', null, 'en'],
    'de-u-co-phonebk': ['de', null, 'de'],
    'en-x-ca': ['en', null, 'en'],
    'en-CA-u-ca-gregory': ['en', 'CA', 'en-CA'],
    constructor: ['constructor', null, 'constructor'],
  };
  for (const [tag, [language, region, canonical]] of Object.entries(cases)) {
    assert.deepEqual(parseLangTag(tag), { language, region, canonical }, tag);
  }
  for (const empty of ['', '   ', null, undefined, 'und', 'mul', 'zxx', 'mis', 'UND', 'und-US', 'mul-Latn']) {
    assert.deepEqual(parseLangTag(empty), { language: '', region: null, canonical: '' });
  }
});

test('plain names of a language are read in English, Italian, its own and its neighbours', () => {
  const names = {
    it: 'Italien Italienisch italienne',
    en: 'Anglais Inglés ingles Englisch',
    fr: 'Französisch Francés',
    de: 'Allemand Alemán',
    es: 'Espagnol Spanisch',
    ko: 'Korean coreano',
    pl: 'Polish polski polacco',
    el: 'Greek greco',
    sv: 'Swedish svenska svedese',
    nb: 'Norwegian norsk norvegese',
    da: 'Danish dansk danese',
    tr: 'Turkish turco',
    cs: 'Czech ceco',
    hu: 'Hungarian magyar ungherese',
    ar: 'Arabic arabo',
    ru: 'russo',
    ja: 'giapponese',
    zh: 'cinese mandarin',
    nl: 'olandese',
    fi: 'Finnish',
    ro: 'Romanian',
  };
  for (const [language, spellings] of Object.entries(names)) {
    for (const name of spellings.split(' ')) assert.equal(parseLangTag(name).language, language, name);
  }
  assert.deepEqual(parseLangTag('Cantonese'), { language: 'zh', region: 'HK', canonical: 'zh-HK' });
});

test('the code of a country stands for its language where a language has no such code', () => {
  const codes = { kr: 'ko', jp: 'ja', cn: 'zh', gr: 'el', cz: 'cs', dk: 'da', ua: 'uk', gb: 'en' };
  for (const [code, language] of Object.entries(codes)) assert.equal(parseLangTag(code).language, language, code);
});

test('a slash, a pipe, quotes or brackets are not part of the language', () => {
  for (const tag of ['it/en', 'it|en', '(it)', '"it"', "'it'", '[it]', '“it”', '( it )', '"it-IT"']) {
    assert.equal(parseLangTag(tag).language, 'it', tag);
  }
  assert.deepEqual(parseLangTag('"en-GB"'), { language: 'en', region: 'GB', canonical: 'en-GB' });
});

const ITALIAN_THAT_LOOKS_LIKE_OTHERS = [
  'I ragazzi e i bambini giocano nel parco, mentre i genitori e i nonni parlano. I cani corrono e i gatti dormono. I negozi aprono alle nove e i clienti arrivano subito. I treni partono in orario e i pendolari vanno a lavorare.',
  'Se mi ami, dimmelo. Se no, me ne vado. Io ti amo, ma tu mi dici di no. Se me lo chiedi ancora, ti rispondo che no, non lo so.',
  'Domani vado al mare con i miei amici.',
  'Mi piace la pizza con il pomodoro.',
  'Ho comprato il pane, la pasta, il latte, le uova, il burro, la farina.',
  'Comprare il latte\nChiamare la banca\nSpedire la lettera\nPagare le bollette',
  'Il gatto dorme sul divano e il cane in giardino.',
  'La riunione è alle dieci.',
  'Il nome della rosa',
  'La vita di un uomo',
  'Aggiornare il server\nChiamare la banca\nPagare le bollette',
  'Comprare il pane\nLavare la macchina\nStirare le camicie',
  'Come stai oggi? Io sto bene, grazie.',
];

test('Italian keeps its answer when its everyday words are also words of other languages', () => {
  for (const sample of ITALIAN_THAT_LOOKS_LIKE_OTHERS) assert.equal(detectLang(sample), 'it', sample);
});

test('short English keeps its answer, also with many a first person', () => {
  for (const sample of [
    'The cat sat on the mat.',
    'Go to the shop on the corner.',
    'I was at home.',
    'I think I know what I want, and I said so.',
    'Tell me if I can go.',
    'Update the server\nCall the bank\nPay the bills',
  ]) {
    assert.equal(detectLang(sample), 'en', sample);
  }
});

const PROSE_THAT_ONLY_SEEMS_ITALIAN = {
  indonesian: [
    'Pagi itu saya berjalan di jalan kecil di belakang rumah. Di sana ada seorang kakek yang duduk di bangku. Dia tersenyum dan bertanya apakah saya tinggal di desa ini. Saya menjawab bahwa saya baru datang kemarin dan menginap di rumah paman saya di ujung jalan.',
    'Indonesia adalah negara di Asia Tenggara yang dilintasi garis khatulistiwa dan berada di antara daratan benua Asia dan Australia, serta antara Samudra Pasifik dan Samudra Hindia. Indonesia merupakan negara kepulauan terbesar di dunia yang terdiri dari 17.504 pulau. Nama alternatif yang biasa dipakai adalah Nusantara. Dengan populasi mencapai 270 juta jiwa, Indonesia merupakan negara berpenduduk terbesar keempat di dunia dan negara yang berpenduduk Muslim terbesar di dunia.',
    'Saya tinggal di rumah di desa.',
  ],
  malay: [
    'Kerajaan di Malaysia mengumumkan undang-undang baharu mengenai perlindungan data peribadi di seluruh negara dan rakyat di bandar itu gembira.',
  ],
  corsican: [
    "A lingua corsa hè una lingua rumanza parlata in Corsica è in u nordu di a Sardegna. Hè stretta parente di u tuscanu è di l'italianu.",
    "A lingua corsa hè una lingua rumanza parlata in Corsica è in u nordu di a Sardegna. Hè stretta parente di u tuscanu è di l'italianu. I parlanti di a lingua corsa sò più di centu mila, è a lingua hè insignata in e scole di l'isula.",
  ],
  sicilian: [
    'Lu cuvernu annunziau na nova liggi supra la prutezzioni dî dati pirsunali e li citatini dâ cità sunnu cuntenti di chiddu ca si fici.',
  ],
  czech: [
    'Petr mu dal knihu a odešel domů bez slova.',
  ],
  albanian: [
    'Qeveria ka njoftuar një ligj të ri për mbrojtjen e të dhënave personale në të gjithë vendin dhe qytetarët e qytetit janë të kënaqur me këtë vendim. Ai tha se e di që ka shumë punë për të bërë.',
  ],
  latin: [
    'Non est ad astra mollis e terris via. Si vis pacem, para bellum. Per aspera ad astra, et in terra pax hominibus bonae voluntatis, quia non est deus nisi unus.',
  ],
  romanian: [
    'Mi se pare că e bine să mergem la mare cu toți prietenii noștri, dar nu știu dacă ai timp să vii cu noi la vară sau dacă se poate altfel.',
  ],
  neapolitan: [
    "O guverno ha annunciato na legge nova ncoppa â pruteziona d'e date personale e 'e cittadine d'a città so cuntente e chello ca s'è fatto.",
  ],
  friulian: [
    'Il guvier al à anunziât une gnove leç su la protezion dai dâts personâi e i citadins de citât a son contents di ce che al è stât fat.',
  ],
  lombard: [
    "El guvern l'ha anunciaa una lege noeuva sora la protezion di dati personai e i sitadin de la sità hinn content de quel che l'è staa faa.",
  ],
};

const PROSE_THAT_ONLY_SEEMS_ENGLISH = {
  czech: [
    'To není jednoduchá otázka. Vláda to chce změnit, ale do konce roku na to nemá peníze. Ministr řekl, že to bude těžké, a poslanci k tomu mají mnoho výhrad. Kdyby to prošlo, do léta by se vše změnilo.',
    'To je to, co chci do konce.',
  ],
  slovak: [
    'To nie je jednoduchá otázka. Vláda to chce zmeniť, ale do konca roka na to nemá peniaze. Minister povedal, že to bude ťažké, a poslanci k tomu majú veľa výhrad. Keby to prešlo, do leta by sa všetko zmenilo.',
  ],
  polish: [
    'To nie jest proste pytanie. Rząd chce to zmienić, ale do końca roku nie ma na to pieniędzy. Minister powiedział, że to będzie trudne, a posłowie mają do tego wiele uwag. Jeśli by to przeszło, to do lata wszystko by się zmieniło.',
  ],
  irish: [
    'Is teanga Cheilteach í an Ghaeilge, agus is í an teanga náisiúnta agus an phríomhtheanga oifigiúil in Éirinn. Tá sí ar cheann de theangacha oifigiúla an Aontais Eorpaigh freisin. Labhraítear an teanga mar theanga phobail sa Ghaeltacht, agus is iomaí duine a labhraíonn í ar fud na tíre.',
  ],
  'Scottish Gaelic': [
    'Tha an riaghaltas ag obair air an lagh ùr agus is e am ministear a thuirt gu bheil an dùthaich toilichte leis an toradh agus is math an naidheachd sin.',
    "Is e cànan Ceilteach a th' anns a' Ghàidhlig, agus tha i ga bruidhinn ann an Alba. Is ann anns na h-Eileanan an Iar a tha an àireamh as motha de luchd-labhairt. Tha an cànan air a bhith ann an Alba o chionn ceudan bhliadhnaichean.",
  ],
};

for (const [language, samples] of Object.entries(PROSE_THAT_ONLY_SEEMS_ITALIAN)) {
  test(`${language} prose does not pass for Italian`, () => {
    for (const sample of samples) assert.equal(detectLang(sample), null, sample);
  });
}

for (const [language, samples] of Object.entries(PROSE_THAT_ONLY_SEEMS_ENGLISH)) {
  test(`${language} prose does not pass for English`, () => {
    for (const sample of samples) assert.equal(detectLang(sample), null, sample);
  });
}

test('short French and Spanish lists are not taken for Italian on the articles they share', () => {
  for (const sample of [
    'Il mange la pomme, il boit le vin.',
    'La femme, la table, le livre, la porte, le monde.',
    'Comprar la leche, llamar al banco.',
  ]) {
    assert.equal(detectLang(sample), null, sample);
  }
});

test('fenced code does not count as words of the text', () => {
  const code = '\n```js\nconst f = (s) => { if (!s) return 0; const n = 1e3; for (const d of s) n; if (s) return n; };\n```\n';
  assert.equal(detectLang(`Tabella generata dal feed di Google.${code}`), 'it');
  assert.equal(detectLang(`La casa di mia nonna è in un piccolo paese.${code}${code}${code}`), 'it');
  assert.equal(detectLang(`The house is in a small town on the coast.\n\`\`\`\nil gatto e la casa di una nonna\nche non ha il pane e la pasta`), 'en');
  assert.equal(detectLang(`~~~\nla casa di una nonna che non ha il pane\n~~~\nThe house is in a small town on the coast.`), 'en');
});

test('one word found only in Italian is enough for a line of foreign terms', () => {
  assert.equal(detectLang('Tabella generata dal feed Google Trending'), 'it');
});

test('dailies that are mostly a code block are recognized', { skip: !existsSync(DAILY_DIR) && 'the vault is not on this machine' }, () => {
  assert.equal(detectLang(readFileSync(join(DAILY_DIR, '2026-02-01.md'), 'utf8')), 'it');
  assert.equal(detectLang(readFileSync(join(DAILY_DIR, '2026-03-14.md'), 'utf8')), 'it');
});
