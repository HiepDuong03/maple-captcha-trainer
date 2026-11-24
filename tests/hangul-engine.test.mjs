import test from 'node:test';
import assert from 'node:assert/strict';
import { HangulEngine } from '../public/js/hangul-engine.js';

test('assembles basic Hangul syllable from QWERTY keys (r, k, d -> 강)', () => {
    const jamos = ['r', 'k', 'd'].map((k) => HangulEngine.mapKeyToJamo(k));
    assert.deepEqual(jamos, ['ㄱ', 'ㅏ', 'ㅇ']);
    assert.equal(HangulEngine.assembleJamos(jamos), '강');
});

test('assembles complex vowels (ㅘ, ㅝ, ㅢ) and splits back accurately', () => {
    const jamos = ['r', 'h', 'k'].map((k) => HangulEngine.mapKeyToJamo(k)); // ㄱ + ㅗ + ㅏ = 과
    assert.equal(HangulEngine.assembleJamos(jamos), '과');
    assert.deepEqual(HangulEngine.decomposeChar('과'), ['ㄱ', 'ㅗ', 'ㅏ']);
    assert.deepEqual(HangulEngine.decomposeChar('의'), ['ㅇ', 'ㅡ', 'ㅣ']);
});

test('assembles and splits double final consonants (patchim) like 닭 and 없', () => {
    const dalk = ['e', 'k', 'f', 'r'].map((k) => HangulEngine.mapKeyToJamo(k)); // ㄷ ㅏ ㄹ ㄱ
    assert.equal(HangulEngine.assembleJamos(dalk), '닭');
    assert.deepEqual(HangulEngine.decomposeChar('닭'), ['ㄷ', 'ㅏ', 'ㄹ', 'ㄱ']);

    // When followed by a vowel, second consonant of patchim carries over: 닭 + ㅣ -> 달기
    const dalgi = [...dalk, HangulEngine.mapKeyToJamo('l')];
    assert.equal(HangulEngine.assembleJamos(dalgi), '달기');
});

test('handles tense consonants via Shift uppercase keys (Q, W, E, R, T)', () => {
    const jamos = ['R', 'k', 's'].map((k) => HangulEngine.mapKeyToJamo(k)); // ㄲ ㅏ ㄴ = 깐
    assert.equal(HangulEngine.assembleJamos(jamos), '깐');
    assert.equal(HangulEngine.getKeyForJamo('ㄲ'), 'R');
});

test('normalizeInputToJamos converts mixed Latin + Hangul without leaking ASCII', () => {
    const normalized = HangulEngine.normalizeInputToJamos('강a');
    assert.equal(HangulEngine.assembleJamos(normalized), '강ㅁ');

    const pureLatin = HangulEngine.normalizeInputToJamos('rkdaheh');
    assert.equal(HangulEngine.assembleJamos(pureLatin), '강모도');
});
