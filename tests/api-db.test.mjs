import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCharMistakes } from '../lib/mistakes.js';
import { resetDbClientForTest } from '../lib/db.js';
import playerHandler from '../api/player.js';
import attemptHandler from '../api/attempt.js';
import testSessionHandler from '../api/test-session.js';
import adminHandler from '../api/admin.js';

function createMockRes() {
    let statusCode = 200;
    let body = null;
    return {
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            body = payload;
            return this;
        },
        writeHead(code) {
            statusCode = code;
        },
        end(raw) {
            body = raw ? JSON.parse(raw) : null;
        },
        get result() {
            return { statusCode, body };
        }
    };
}

test('extractCharMistakes detects substituted characters and empty reveal/timeout inputs', () => {
    // Đáp án '대해머스' nhưng gõ '내헤머스' -> nhầm 대->내 và 해->헤
    const subs = extractCharMistakes('대해머스', '내헤머스', 'wrong');
    assert.deepEqual(subs, [
        { expectedChar: '대', actualChar: '내' },
        { expectedChar: '해', actualChar: '헤' }
    ]);

    // Xem đáp án khi chưa gõ gì -> ghi nhận đủ từng ký tự của mã
    const empty = extractCharMistakes('강모', '', 'reveal');
    assert.deepEqual(empty, [
        { expectedChar: '강', actualChar: '' },
        { expectedChar: '모', actualChar: '' }
    ]);
});

test('End-to-end SQL APIs: player upsert, attempt logging, error analytics, test session, and ADMIN_PIN', async () => {
    process.env.LOCAL_DB_URL = ':memory:';
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.ADMIN_PIN;
    resetDbClientForTest();

    // 1. Upsert 2 players
    for (const p of [
        { userId: 'u-thanh', name: 'Thành' },
        { userId: 'u-viet', name: 'Việt' }
    ]) {
        const res = createMockRes();
        await playerHandler({ method: 'POST', body: p, headers: {} }, res);
        assert.equal(res.result.statusCode, 200);
        assert.equal(res.result.body.ok, true);
    }

    // 2. Record correct attempt + wrong attempt with confusion pair (대 -> 내) for both players
    {
        const res = createMockRes();
        await attemptHandler({
            method: 'POST',
            body: {
                userId: 'u-thanh',
                name: 'Thành',
                target: '대해머스',
                typedInput: '대해머스',
                isCorrect: true,
                elapsedMs: 4200,
                solved: 1,
                bestCombo: 1,
                totalTimeMs: 4200,
                accuracyPct: 100
            },
            headers: {}
        }, res);
        assert.equal(res.result.statusCode, 200);
        assert.equal(res.result.body.mistakesRecorded, 0);
    }

    for (const uid of ['u-thanh', 'u-viet']) {
        const res = createMockRes();
        await attemptHandler({
            method: 'POST',
            body: {
                userId: uid,
                name: uid === 'u-thanh' ? 'Thành' : 'Việt',
                target: '대해머스',
                typedInput: '내해머스',
                isCorrect: false,
                errorType: 'wrong',
                elapsedMs: 5100,
                solved: uid === 'u-thanh' ? 1 : 0,
                wrongCount: 1,
                accuracyPct: uid === 'u-thanh' ? 50 : 0
            },
            headers: {}
        }, res);
        assert.equal(res.result.statusCode, 200);
        assert.equal(res.result.body.mistakesRecorded, 1);
    }

    // 3. Record a Test Mode session
    {
        const res = createMockRes();
        await testSessionHandler({
            method: 'POST',
            body: {
                userId: 'u-thanh',
                name: 'Thành',
                totalQuestions: 10,
                passedCount: 9,
                failedCount: 1,
                accuracyPct: 90,
                avgSec: 7.5,
                totalSec: 67.5,
                isPass: true,
                label: 'PASS (9/10 • 7.50s)',
                missedTargets: ['히든스트리트']
            },
            headers: {}
        }, res);
        assert.equal(res.result.statusCode, 200);
        assert.equal(res.result.body.ok, true);
    }

    // 4. Query Admin Dashboard (team analytics + player drilldown)
    {
        const res = createMockRes();
        await adminHandler({
            method: 'GET',
            url: '/api/admin?range=all&playerId=u-thanh',
            headers: {}
        }, res);
        assert.equal(res.result.statusCode, 200);
        const data = res.result.body;
        assert.equal(data.adminUnlocked, true);
        assert.equal(data.teamRecords.length, 2);
        const thanhRec = data.teamRecords.find((r) => r.userId === 'u-thanh');
        assert.equal(thanhRec.topWeakChars[0].char, '대');
        assert.equal(thanhRec.topWeakChars[0].mistakes, 1);
        assert.equal(data.analytics.breakdown.correct, 1);
        assert.equal(data.analytics.breakdown.wrong, 2);
        assert.equal(data.analytics.topHardChars[0].char, '대');
        assert.equal(data.analytics.topHardChars[0].mistakes, 2);
        assert.equal(data.analytics.topHardChars[0].affectedPlayers, 2);
        assert.equal(data.analytics.confusionPairs[0].expected, '대');
        assert.equal(data.analytics.confusionPairs[0].actual, '내');
        assert.equal(data.analytics.confusionPairs[0].count, 2);
        assert.equal(data.analytics.recentTests.length, 1);
        assert.equal(data.playerDetail.recentErrors.length, 1);
        assert.equal(data.playerDetail.testHistory.length, 1);
    }

    // 5. Verify ADMIN_PIN lock & unlock
    process.env.ADMIN_PIN = '9999';
    {
        const resLocked = createMockRes();
        await adminHandler({ method: 'GET', url: '/api/admin?range=all', headers: {} }, resLocked);
        assert.equal(resLocked.result.body.pinRequired, true);
        assert.equal(resLocked.result.body.adminUnlocked, false);
        assert.equal(resLocked.result.body.analytics, undefined);

        const resUnlocked = createMockRes();
        await adminHandler({
            method: 'GET',
            url: '/api/admin?range=all',
            headers: { 'x-admin-pin': '9999' }
        }, resUnlocked);
        assert.equal(resUnlocked.result.body.adminUnlocked, true);
        assert.equal(resUnlocked.result.body.analytics.breakdown.wrong, 2);
    }

    delete process.env.ADMIN_PIN;
    delete process.env.LOCAL_DB_URL;
    resetDbClientForTest();
});

test('Name + 4-digit PIN auth merges same player across devices, blocks wrong PIN, and supports Admin Reset PIN', async () => {
    process.env.LOCAL_DB_URL = ':memory:';
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.ADMIN_PIN;
    resetDbClientForTest();

    // 1. Register new player on PC
    const regRes = createMockRes();
    await playerHandler({
        method: 'POST',
        body: { action: 'login', name: 'Thành', pin: '1234' },
        headers: {}
    }, regRes);
    assert.equal(regRes.result.statusCode, 200);
    assert.equal(regRes.result.body.authMode, 'register');
    const canonicalId = regRes.result.body.profile.userId;
    assert.ok(canonicalId.startsWith('p-'));

    // Record 1 solved attempt on PC
    const attRes = createMockRes();
    await attemptHandler({
        method: 'POST',
        body: {
            userId: canonicalId,
            name: 'Thành',
            target: '헤네시스',
            typedInput: '헤네시스',
            isCorrect: true,
            elapsedMs: 3800,
            solved: 1,
            bestCombo: 1,
            totalTimeMs: 3800,
            accuracyPct: 100
        },
        headers: {}
    }, attRes);
    assert.equal(attRes.result.statusCode, 200);

    // 2. Login on phone with different casing/spaces ("  thành  " + "1234") -> exact same userId + merged stats!
    const phoneRes = createMockRes();
    await playerHandler({
        method: 'POST',
        body: { action: 'login', name: '  thành  ', pin: '1234' },
        headers: {}
    }, phoneRes);
    assert.equal(phoneRes.result.statusCode, 200);
    assert.equal(phoneRes.result.body.authMode, 'login');
    assert.equal(phoneRes.result.body.profile.userId, canonicalId);
    assert.equal(phoneRes.result.body.profile.solved, 1);
    assert.equal(phoneRes.result.body.profile.todaySolved, 1);

    // 3. Wrong PIN is rejected with 401 WRONG_PIN
    const wrongRes = createMockRes();
    await playerHandler({
        method: 'POST',
        body: { action: 'login', name: 'Thành', pin: '9999' },
        headers: {}
    }, wrongRes);
    assert.equal(wrongRes.result.statusCode, 401);
    assert.equal(wrongRes.result.body.code, 'WRONG_PIN');

    // 4. Admin resets PIN -> member reclaims same account with new PIN 5678 without losing progress
    const resetRes = createMockRes();
    await adminHandler({
        method: 'PATCH',
        body: { action: 'reset-pin', playerId: canonicalId },
        headers: {}
    }, resetRes);
    assert.equal(resetRes.result.statusCode, 200);
    assert.equal(resetRes.result.body.ok, true);

    const reclaimRes = createMockRes();
    await playerHandler({
        method: 'POST',
        body: { action: 'login', name: 'Thành', pin: '5678' },
        headers: {}
    }, reclaimRes);
    assert.equal(reclaimRes.result.statusCode, 200);
    assert.equal(reclaimRes.result.body.authMode, 'claimed');
    assert.equal(reclaimRes.result.body.profile.userId, canonicalId);
    assert.equal(reclaimRes.result.body.profile.solved, 1);

    delete process.env.LOCAL_DB_URL;
    resetDbClientForTest();
});

test('4-Level progression, Admin timer settings, AFK outlier capping, and Reset Today data', async () => {
    process.env.LOCAL_DB_URL = ':memory:';
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.ADMIN_PIN;
    resetDbClientForTest();

    // 1. Admin configures Lv.1 to 6s / 2 solved / minDifficulty='hard', and Lv.2 to 500 solved (>200 allowed!)
    const setRes = createMockRes();
    await adminHandler({
        method: 'PATCH',
        body: {
            action: 'update-settings',
            levelConfig: {
                lockProgression: true,
                levels: {
                    1: { timeLimitSec: 6, requiredSolved: 2, minAccuracyPct: 90, minDifficulty: 'hard' },
                    2: { timeLimitSec: 15, requiredSolved: 500, minAccuracyPct: 90, minDifficulty: 'medium' }
                }
            }
        },
        headers: {}
    }, setRes);
    assert.equal(setRes.result.statusCode, 200);
    assert.equal(setRes.result.body.levelConfig.levels[1].timeLimitSec, 6);
    assert.equal(setRes.result.body.levelConfig.levels[1].minDifficulty, 'hard');
    assert.equal(setRes.result.body.levelConfig.levels[2].requiredSolved, 500);

    // 2. Register player & submit easy attempt (should NOT count toward Lv.1 with minDifficulty='hard')
    const reg = createMockRes();
    await playerHandler({ method: 'POST', body: { action: 'login', name: 'Phương', pin: '1111' }, headers: {} }, reg);
    const uid = reg.result.body.profile.userId;

    const aEasy = createMockRes();
    await attemptHandler({
        method: 'POST',
        body: { userId: uid, name: 'Phương', mode: 'practice', difficulty: 'easy', target: '가', typedInput: '가', isCorrect: true, elapsedMs: 1500 },
        headers: {}
    }, aEasy);
    assert.equal(aEasy.result.body.levelProgress[1].solved, 0);
    assert.equal(aEasy.result.body.currentLevel, 1);

    // Submit 2 qualifying 'hard' attempts (1st has AFK 142720ms -> capped to 6000ms)
    const a1 = createMockRes();
    await attemptHandler({
        method: 'POST',
        body: { userId: uid, name: 'Phương', mode: 'practice', difficulty: 'hard', target: '가', typedInput: '가', isCorrect: true, elapsedMs: 142720 },
        headers: {}
    }, a1);
    assert.equal(a1.result.body.summary.totalTimeMs, 7500); // 1500 + capped 6000
    assert.equal(a1.result.body.levelProgress[1].solved, 1);
    assert.equal(a1.result.body.currentLevel, 1);

    const a2 = createMockRes();
    await attemptHandler({
        method: 'POST',
        body: { userId: uid, name: 'Phương', mode: 'practice', difficulty: 'hard', target: '나', typedInput: '나', isCorrect: true, elapsedMs: 2000 },
        headers: {}
    }, a2);
    assert.equal(a2.result.body.levelProgress[1].solved, 2);
    assert.equal(a2.result.body.currentLevel, 2);
    assert.equal(a2.result.body.leveledUp, true);

    // 3. Admin resets today's data -> todaySolved becomes 0, account still exists!
    const delToday = createMockRes();
    await adminHandler({ method: 'DELETE', url: '/api/admin?scope=today', headers: {} }, delToday);
    assert.equal(delToday.result.statusCode, 200);
    assert.equal(delToday.result.body.cleared, 'today');

    const afterReset = createMockRes();
    await adminHandler({ method: 'GET', url: '/api/admin?range=today', headers: {} }, afterReset);
    assert.equal(afterReset.result.body.teamRecords.length, 1);
    assert.equal(afterReset.result.body.teamRecords[0].todaySolved, 0);
    assert.equal(afterReset.result.body.teamRecords[0].solved, 0);

    delete process.env.LOCAL_DB_URL;
    resetDbClientForTest();
});

test('Rolling 30-attempt window allows recovery from early mistakes without getting stuck', async () => {
    process.env.LOCAL_DB_URL = ':memory:';
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.ADMIN_PIN;
    resetDbClientForTest();

    const setRes = createMockRes();
    await adminHandler({
        method: 'PATCH',
        body: {
            action: 'update-settings',
            levelConfig: {
                lockProgression: true,
                levels: { 1: { timeLimitSec: 8, requiredSolved: 30, minAccuracyPct: 90, minDifficulty: 'easy' } }
            }
        },
        headers: {}
    }, setRes);

    const reg = createMockRes();
    await playerHandler({ method: 'POST', body: { action: 'login', name: 'Newbie', pin: '2222' }, headers: {} }, reg);
    const uid = reg.result.body.profile.userId;

    for (let i = 0; i < 5; i++) {
        const r = createMockRes();
        await attemptHandler({
            method: 'POST',
            body: { userId: uid, name: 'Newbie', mode: 'practice', difficulty: 'easy', target: '가', typedInput: '나', isCorrect: false, errorType: 'wrong', elapsedMs: 2000 },
            headers: {}
        }, r);
    }

    let lastBody = null;
    for (let i = 0; i < 30; i++) {
        const r = createMockRes();
        await attemptHandler({
            method: 'POST',
            body: { userId: uid, name: 'Newbie', mode: 'practice', difficulty: 'easy', target: '가', typedInput: '가', isCorrect: true, elapsedMs: 1800 },
            headers: {}
        }, r);
        lastBody = r.result.body;
    }

    assert.equal(lastBody.levelProgress[1].solved, 30);
    assert.equal(lastBody.levelProgress[1].accuracyPct, 100);
    assert.equal(lastBody.levelProgress[1].windowSize, 30);
    assert.equal(lastBody.currentLevel, 2);
    assert.equal(lastBody.leveledUp, true);

    delete process.env.LOCAL_DB_URL;
    resetDbClientForTest();
});
