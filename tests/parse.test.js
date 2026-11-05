import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeText, parseCues, parseTimestamp } from '../src/lib/parse.js';

const sample = name => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('parseTimestamp', () => {
  it('reads SRT, VTT and ASS times', () => {
    expect(parseTimestamp('00:01:02,500')).toBe(62.5);
    expect(parseTimestamp('01:02.5')).toBe(62.5);
    expect(parseTimestamp('0:01:02.25')).toBe(62.25);
    expect(parseTimestamp('nope')).toBeNull();
  });
});

describe('parseCues', () => {
  it('cleans SRT lines: tags, speakers, sounds, entities, duplicates and all-caps signs', () => {
    expect(parseCues(sample('sample.srt'))).toEqual([
      { t: 1, text: 'Kaixo, zer moduz zaude gaur?' },
      { t: 5.1, text: '- Ondo, eskerrik asko. Mikel etorri da etxera.' },
      { t: 5.1, text: '- Benetan? Mikel & Ane ere bai?' },
      { t: 9, text: 'Itsasoa ikusi nahi dut' },
      { t: 62.25, text: 'Emakumeak etxeetan daude, eta gizonak kalean ikus-entzunezko lanetan.' },
      { t: 62.25, text: 'Gaur ere Mikel ez da etorri. ¿Zergatik ez? "Etxean" dago.' },
    ]);
  });

  it('reads ASS dialogue with commas in the text and override tags', () => {
    expect(parseCues(sample('sample.ass'))).toEqual([
      { t: 1.5, text: 'Mendira joango gara bihar, lagunekin. Oso polita da.' },
      { t: 62.25, text: 'Bai, Donostiako hondartza ederra da, ederra benetan.' },
    ]);
  });
});

describe('decodeText', () => {
  it('falls back to Latin-1 for non-UTF-8 files', () => {
    expect(decodeText(new Uint8Array([0x6e, 0xf1, 0x61]))).toBe('nña');
    expect(decodeText(new TextEncoder().encode('ñ'))).toBe('ñ');
  });
});
