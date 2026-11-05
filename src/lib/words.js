// Tokenize subtitle lines, count words and decide which ones are worth studying.

// Basque function words (and common inflected forms) that aren't worth studying.
export const BASQUE_STOPWORDS = new Set(`
  eta edo ez bai ba bada baita ezta baina ere ordea aldiz berriz ala al ote omen bait zeren ezen baldin nahiz
  oso hain asko gutxi gehiago gehien guztiz bakarrik jada dagoeneko noski agian hala horrela honela orduan
  hemen han hor hona hara horra hemendik handik hortik orain gero beti inoiz nehoiz behin oraindik
  bat bi hiru lau bost sei zazpi zortzi bederatzi hamar
  gabe baino bezala bezain arte buruz zehar gain azpi aurrean atzean
  guztia guztiak guztiek guztien guztiei batzuk batzuek batzuei edozein edonor edonon edonoiz zenbait zenbat
  ezer inor inon inork ezertarako ezein bestea bestelako beste
  ni nik niri nire nigan zu zuk zuri zure zugan hura hark hari haren hau honek honi honen hori horrek horri horren
  hauek hauen hauei horiek horien horiei haiek haien haiei gu guk guri gure zuek zuei zuen
  bere beren geure zeure
  zer zein nor nork nori noren non nola noiz zergatik zertarako nondik nora
  izan ukan egon edin ezan ahal behar nahi
  da dira zen ziren naiz zara gara zarete nintzen zinen ginen zineten dela direla zela zirela naizela zarela garela
  du dut duzu dugu duzue dute zuen nuen zenuen genuen zenuten zuten dudan duen dutela duela
  dago daude zegoen zeuden dagoen daudenak dauka daukat daukazu daukagu dauzka dauzkat
  izango izateko izatea izaten izanda izanik egongo
`.split(/\s+/).filter(Boolean));

// Stopword lists by subtitle language. Other languages rely on min length and the Jev/LLM filters.
export const STOPWORDS = { eu: BASQUE_STOPWORDS };

// Letters only, so apostrophes and hyphens split tokens (Basque compounds like "ikus-entzunezko").
const TOKEN_RE = /\p{L}+/gu;
const BEFORE_TOKEN_RE = /[ \-–—"'“¿¡([]+$/u;
// Dictionary forms (lemmas) may legitimately contain hyphens.
export const LEMMA_RE = /^\p{L}+(?:-\p{L}+)*$/u;

const EXAMPLE_MIN = 20, EXAMPLE_MAX = 60;

/** Yield [line, [[token, capitalizedMidSentence], ...]]. */
function* regexTokens(lines) {
  for (const line of lines) {
    const tokens = [];
    for (const m of line.matchAll(TOKEN_RE)) {
      const before = line.slice(0, m.index).replace(BEFORE_TOKEN_RE, '');
      const sentenceStart = !before || '.!?…:'.includes(before.at(-1));
      tokens.push([m[0].toLowerCase(), /^\p{Lu}/u.test(m[0]) && !sentenceStart]);
    }
    yield [line, tokens];
  }
}

export function examplePenalty(line) {
  const n = [...line].length;
  return Math.max(EXAMPLE_MIN - n, n - EXAMPLE_MAX, 0);
}

/**
 * Count every word and say why it is discarded: {word, count, example, reason} with reason null (kept) or a code.
 * `nameHeuristic` treats words only ever capitalized mid-sentence as names; turn it off for languages like German.
 */
export function analyzeWords(lines, { minLen = 4, minFreq = 1, limit = 150, known = new Set(), stopwords = BASQUE_STOPWORDS, nameHeuristic = true } = {}) {
  const counts = new Map();
  const examples = new Map(); // word -> [penalty, line]
  const nameLike = new Map(); // only ever seen capitalized mid-sentence => probably a name
  for (const [line, tokens] of regexTokens(lines)) {
    const seen = new Set();
    for (const [w, midCap] of tokens) {
      counts.set(w, (counts.get(w) || 0) + 1);
      nameLike.set(w, (nameLike.get(w) ?? true) && midCap);
      if (seen.has(w)) continue;
      seen.add(w);
      const penalty = examplePenalty(line);
      if (!examples.has(w) || penalty < examples.get(w)[0]) examples.set(w, [penalty, line]);
    }
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]); // stable: ties keep first-seen order
  const items = [];
  let kept = 0;
  for (const [w, c] of sorted) {
    let reason = null;
    if (stopwords.has(w)) reason = 'stopword';
    else if ([...w].length < minLen) reason = 'short';
    else if (known.has(w)) reason = 'known';
    else if (nameHeuristic && nameLike.get(w)) reason = 'name';
    else if (c < minFreq) reason = 'freq';
    else if (kept >= limit) reason = 'limit';
    else kept++;
    items.push({ word: w, count: c, example: examples.get(w)[1], reason });
  }
  return items;
}

/** Group surface forms (sorted by count, descending) under their lemma; returns [words, known lemma count]. */
export function mergeLemmas(items, known) {
  const merged = new Map();
  const knownHits = new Set();
  for (const it of items) {
    const lemma = it.lemma == null ? it.word : it.lemma;
    if (!lemma) continue;
    if (known.has(lemma)) {
      knownHits.add(lemma);
      continue;
    }
    const m = merged.get(lemma);
    if (!m) {
      merged.set(lemma, { word: lemma, count: it.count, translation: it.translation, example: it.example, forms: [it.word] });
      continue;
    }
    m.count += it.count;
    m.forms.push(it.word);
    m.translation = m.translation || it.translation;
    if (examplePenalty(it.example) < examplePenalty(m.example)) m.example = it.example;
  }
  return [[...merged.values()], knownHits.size];
}
