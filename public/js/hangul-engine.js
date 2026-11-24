/**
 * Module xử lý tiếng Hàn 2-Set Hangul (Phân tách, ghép Jamo & chuẩn hóa chuỗi nhập liệu).
 * Hoạt động thuần ESM — dùng chung được cho cả trình duyệt và unit test Node.js.
 */
export const HangulEngine = (() => {
    const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
    const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

    const COMPLEX_VOWEL_SPLIT = {
        'ㅘ': ['ㅗ','ㅏ'], 'ㅙ': ['ㅗ','ㅐ'], 'ㅚ': ['ㅗ','ㅣ'],
        'ㅝ': ['ㅜ','ㅓ'], 'ㅞ': ['ㅜ','ㅔ'], 'ㅟ': ['ㅜ','ㅣ'], 'ㅢ': ['ㅡ','ㅣ']
    };
    const COMPLEX_VOWEL_COMBINE = {
        'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ',
        'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ'
    };

    const COMPLEX_JONG_SPLIT = {
        'ㄳ': ['ㄱ','ㅅ'], 'ㄵ': ['ㄴ','ㅈ'], 'ㄶ': ['ㄴ','ㅎ'],
        'ㄺ': ['ㄹ','ㄱ'], 'ㄻ': ['ㄹ','ㅁ'], 'ㄼ': ['ㄹ','ㅂ'],
        'ㄽ': ['ㄹ','ㅅ'], 'ㄾ': ['ㄹ','ㅌ'], 'ㄿ': ['ㄹ','ㅍ'],
        'ㅀ': ['ㄹ','ㅎ'], 'ㅄ': ['ㅂ','ㅅ']
    };
    const COMPLEX_JONG_COMBINE = {
        'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ',
        'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ',
        'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ',
        'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ'
    };

    const KEY_TO_JAMO = {
        'q':'ㅂ','Q':'ㅃ','w':'ㅈ','W':'ㅉ','e':'ㄷ','E':'ㄸ','r':'ㄱ','R':'ㄲ','t':'ㅅ','T':'ㅆ',
        'y':'ㅛ','u':'ㅕ','i':'ㅑ','o':'ㅐ','O':'ㅒ','p':'ㅔ','P':'ㅖ',
        'a':'ㅁ','s':'ㄴ','d':'ㅇ','f':'ㄹ','g':'ㅎ','h':'ㅗ','j':'ㅓ','k':'ㅏ','l':'ㅣ',
        'z':'ㅋ','x':'ㅌ','c':'ㅊ','v':'ㅍ','b':'ㅠ','n':'ㅜ','m':'ㅡ'
    };

    const JAMO_TO_KEY = {};
    Object.entries(KEY_TO_JAMO).forEach(([k, j]) => { JAMO_TO_KEY[j] = k; });

    function isVowel(j) {
        return JUNG.includes(j);
    }

    function mapKeyToJamo(key) {
        if (KEY_TO_JAMO[key]) return KEY_TO_JAMO[key];
        const lower = key.toLowerCase();
        if (KEY_TO_JAMO[lower]) return KEY_TO_JAMO[lower];
        return null;
    }

    function decomposeChar(ch) {
        const code = ch.charCodeAt(0);
        if (code >= 0xAC00 && code <= 0xD7A3) {
            const offset = code - 0xAC00;
            const choIdx = Math.floor(offset / 588);
            const jungIdx = Math.floor((offset % 588) / 28);
            const jongIdx = offset % 28;
            const result = [CHO[choIdx]];

            const v = JUNG[jungIdx];
            if (COMPLEX_VOWEL_SPLIT[v]) result.push(...COMPLEX_VOWEL_SPLIT[v]);
            else result.push(v);

            if (jongIdx > 0) {
                const j = JONG[jongIdx];
                if (COMPLEX_JONG_SPLIT[j]) result.push(...COMPLEX_JONG_SPLIT[j]);
                else result.push(j);
            }
            return result;
        }
        if (COMPLEX_VOWEL_SPLIT[ch]) return [...COMPLEX_VOWEL_SPLIT[ch]];
        if (COMPLEX_JONG_SPLIT[ch]) return [...COMPLEX_JONG_SPLIT[ch]];
        return [ch];
    }

    function decomposeString(str) {
        const out = [];
        for (const ch of String(str || '')) {
            out.push(...decomposeChar(ch));
        }
        return out;
    }

    /**
     * Chuẩn hóa chuỗi nhập liệu: chuyển mọi chữ cái Latin [a-zA-Z] (trường hợp lọt từ bộ gõ/mobile/synthetic input)
     * sang Jamo tương ứng, đồng thời phân tách sẵn các âm tiết Hangul đã ghép.
     */
    function normalizeInputToJamos(str) {
        const out = [];
        for (const ch of String(str || '')) {
            if (/^[a-zA-Z]$/.test(ch)) {
                const j = mapKeyToJamo(ch);
                if (j) out.push(j);
            } else {
                out.push(...decomposeChar(ch));
            }
        }
        return out;
    }

    function assembleJamos(jamos) {
        let res = '';
        let cho = -1, jung = -1, jong = 0;

        const flush = () => {
            if (cho !== -1 && jung !== -1) {
                res += String.fromCharCode(0xAC00 + cho * 588 + jung * 28 + jong);
            } else if (cho !== -1) {
                res += CHO[cho];
            } else if (jung !== -1) {
                res += JUNG[jung];
            }
            cho = -1; jung = -1; jong = 0;
        };

        for (const j of jamos) {
            if (isVowel(j)) {
                const jIdx = JUNG.indexOf(j);
                if (cho !== -1 && jung === -1) {
                    jung = jIdx;
                } else if (cho !== -1 && jung !== -1 && jong === 0) {
                    const combined = COMPLEX_VOWEL_COMBINE[JUNG[jung] + j];
                    if (combined) {
                        jung = JUNG.indexOf(combined);
                    } else {
                        flush();
                        jung = jIdx;
                    }
                } else if (cho !== -1 && jung !== -1 && jong !== 0) {
                    const curJong = JONG[jong];
                    if (COMPLEX_JONG_SPLIT[curJong]) {
                        const [firstJ, secondJ] = COMPLEX_JONG_SPLIT[curJong];
                        jong = JONG.indexOf(firstJ);
                        flush();
                        cho = CHO.indexOf(secondJ);
                        jung = jIdx;
                    } else {
                        const carryCho = CHO.indexOf(curJong);
                        jong = 0;
                        flush();
                        cho = carryCho;
                        jung = jIdx;
                    }
                } else {
                    flush();
                    jung = jIdx;
                }
            } else {
                const cIdx = CHO.indexOf(j);
                if (cIdx === -1) {
                    flush();
                    res += j;
                    continue;
                }
                if (cho === -1 && jung === -1) {
                    cho = cIdx;
                } else if (cho !== -1 && jung === -1) {
                    flush();
                    cho = cIdx;
                } else if (cho !== -1 && jung !== -1 && jong === 0) {
                    const jgIdx = JONG.indexOf(j);
                    if (jgIdx > 0) {
                        jong = jgIdx;
                    } else {
                        flush();
                        cho = cIdx;
                    }
                } else if (cho !== -1 && jung !== -1 && jong !== 0) {
                    const combinedJong = COMPLEX_JONG_COMBINE[JONG[jong] + j];
                    if (combinedJong) {
                        jong = JONG.indexOf(combinedJong);
                    } else {
                        flush();
                        cho = cIdx;
                    }
                } else {
                    flush();
                    cho = cIdx;
                }
            }
        }
        flush();
        return res;
    }

    function getKeyForJamo(jamo) {
        return JAMO_TO_KEY[jamo] || '';
    }

    return {
        mapKeyToJamo,
        decomposeChar,
        decomposeString,
        normalizeInputToJamos,
        assembleJamos,
        getKeyForJamo
    };
})();
