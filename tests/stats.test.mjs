import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getTodayKey,
    calcAccuracy,
    recordWeakness,
    getTopWeakChars,
    pickWeightedChar,
    evaluateTestResult,
    formatTestDiscordReport,
    exportTeamCsv,
    classifyMemberAndRecommend,
    formatCoachingDiscordReport
} from '../js/stats.js';

test('getTodayKey formats local date as YYYY-MM-DD', () => {
    const d = new Date(2026, 10, 5); // 2026-11-05
    assert.equal(getTodayKey(d), '2026-11-05');
});

test('calcAccuracy computes percentage accurately and defaults to 100 when empty', () => {
    assert.equal(calcAccuracy(0, 0, 0, 0), 100);
    assert.equal(calcAccuracy(9, 1, 0, 0), 90);
    assert.equal(calcAccuracy(8, 1, 1, 0), 80);
});

test('recordWeakness & getTopWeakChars rank errored/slow characters first', () => {
    let weak = {};
    weak = recordWeakness(weak, '강', { isError: true, elapsedMs: 3000 });
    weak = recordWeakness(weak, '강', { isError: true, elapsedMs: 3000 });
    weak = recordWeakness(weak, '나', { isError: false, elapsedMs: 800 });

    const top = getTopWeakChars(weak, 5);
    assert.equal(top.length, 1);
    assert.equal(top[0].ch, '강');
    assert.equal(top[0].wrong, 2);

    // rng returning 0.1 (< 0.6) picks from weak chars
    assert.equal(pickWeightedChar(weak, ['나', '다'], () => 0.1), '강');
    // rng returning 0.9 (>= 0.6) picks from fallback pool
    assert.equal(pickWeightedChar(weak, ['나', '다'], () => 0.9), '다');
});

test('evaluateTestResult grades PASS and FAIL based on thresholds', () => {
    const thresholds = { passAccuracyPct: 90, passAvgSec: 10.0 };

    const passRes = evaluateTestResult({
        totalQuestions: 10,
        passedCount: 9,
        failedCount: 1,
        totalTimeMs: 72000, // 8.0s/captcha
        missedTargets: ['히든스트리트']
    }, thresholds);
    assert.equal(passRes.isPass, true);
    assert.equal(passRes.accuracyPct, 90);
    assert.equal(passRes.avgSec, 8);

    const failSpeedRes = evaluateTestResult({
        totalQuestions: 10,
        passedCount: 10,
        failedCount: 0,
        totalTimeMs: 120000, // 12.0s/captcha > 10s
        missedTargets: []
    }, thresholds);
    assert.equal(failSpeedRes.isPass, false);

    const report = formatTestDiscordReport('Thành', passRes, thresholds);
    assert.match(report, /✅ PASS/);
    assert.match(report, /히든스트리트/);
});

test('exportTeamCsv prepends UTF-8 BOM and escapes commas and quotes', () => {
    const csv = exportTeamCsv([
        {
            name: 'Nam, "Pro"',
            solved: 25,
            todaySolved: 10,
            accuracyPct: 95.5,
            avgTimeSec: 6.42,
            bestCombo: 12,
            bestTestLabel: 'PASS (10/10 • 6.10s)',
            lastMode: 'reflex',
            lastDifficulty: 'medium',
            lastActiveAt: 1700000000000
        }
    ]);
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.match(csv, /"Nam, ""Pro"""/);
    assert.match(csv, /25,10,95.5,6.42,12/);
});

test('classifyMemberAndRecommend categorizes pass/improve/urgent and generates coaching advice', () => {
    const passMember = classifyMemberAndRecommend({
        name: 'A',
        solved: 25,
        accuracyPct: 94,
        avgTimeSec: 7.2,
        topWeakChars: [{ char: '대', mistakes: 1 }]
    });
    assert.equal(passMember.tier, 'pass');
    assert.match(passMember.advice, /대/);

    const urgentMember = classifyMemberAndRecommend({
        name: 'B',
        solved: 12,
        accuracyPct: 72,
        avgTimeSec: 14.5,
        topWeakChars: [{ char: '해', mistakes: 4 }, { char: '어', mistakes: 3 }]
    });
    assert.equal(urgentMember.tier, 'urgent');
    assert.match(urgentMember.advice, /Tập Phím/);
    assert.match(urgentMember.advice, /해, 어/);

    const improveMember = classifyMemberAndRecommend({
        name: 'C',
        solved: 15,
        accuracyPct: 86,
        avgTimeSec: 11.2,
        topWeakChars: []
    });
    assert.equal(improveMember.tier, 'improve');

    const report = formatCoachingDiscordReport(
        [
            { name: 'A', solved: 25, todaySolved: 10, accuracyPct: 94, avgTimeSec: 7.2 },
            { name: 'B', solved: 12, todaySolved: 2, accuracyPct: 72, avgTimeSec: 14.5, topWeakChars: [{ char: '해', mistakes: 4 }] }
        ],
        { topHardChars: [{ char: '해', mistakes: 5 }], confusionPairs: [{ expected: '대', actual: '내', count: 3 }] },
        '2026-11-24'
    );
    assert.match(report, /🔴 CẦN BỔ TÚC GẤP:/);
    assert.match(report, /🟢 ĐẠT CHUẨN \(1\): A/);
    assert.match(report, /대→내\(3\)/);
});
