import { describe, expect, it } from 'vitest';
import { analyzeWords, mergeLemmas } from '../src/lib/words.js';

describe('analyzeWords', () => {
  const lines = [
    'Gaur Mikel etorri da etxera.',
    'Bihar ere Mikel ez da etorri.',
    'Etxean dago, eta etxera joango gara.',
  ];

  it('counts words and gives a reason for each discarded one', () => {
    const byWord = Object.fromEntries(analyzeWords(lines, { known: new Set(['joango']) }).map(w => [w.word, w]));
    expect(byWord.etorri).toMatchObject({ count: 2, reason: null });
    expect(byWord.etxera).toMatchObject({ count: 2, reason: null });
    expect(byWord.mikel.reason).toBe('name');
    expect(byWord.eta.reason).toBe('stopword');
    expect(byWord.gara.reason).toBe('stopword');
    expect(byWord.ere.reason).toBe('stopword');
    expect(byWord.joango.reason).toBe('known');
    expect(byWord.gaur.reason).toBe(null); // capitalized only at sentence start
  });

  it('applies min frequency and the candidate limit in count order', () => {
    const items = analyzeWords(lines, { minFreq: 2, limit: 1 });
    expect(items.filter(w => !w.reason).map(w => w.word)).toEqual(['etorri']);
    expect(items.find(w => w.word === 'etxera').reason).toBe('limit');
    expect(items.find(w => w.word === 'etxean').reason).toBe('freq');
  });
});

describe('mergeLemmas', () => {
  it('groups inflected forms under their lemma and drops rejected or known ones', () => {
    const items = [
      { word: 'etxera', count: 3, example: 'Etxera noa orain bertan, laster arte.', lemma: 'etxe', translation: 'casa' },
      { word: 'etxean', count: 2, example: 'Etxean nago.', lemma: 'etxe', translation: '' },
      { word: 'mikel', count: 2, example: 'Mikel', lemma: '', translation: '' },
      { word: 'ikusi', count: 1, example: 'Ikusi dut.', lemma: 'ikusi', translation: 'ver' },
    ];
    const [words, knownHits] = mergeLemmas(items, new Set(['ikusi']));
    expect(knownHits).toBe(1);
    expect(words).toEqual([
      { word: 'etxe', count: 5, translation: 'casa', example: 'Etxera noa orain bertan, laster arte.', forms: ['etxera', 'etxean'] },
    ]);
  });
});
