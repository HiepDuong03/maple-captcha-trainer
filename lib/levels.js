/**
 * Cấu hình chuẩn 4 Level (Lv.1: 1 chữ -> Lv.2: 3 chữ -> Lv.3: 6 chữ -> Lv.4: Thi Test 6 chữ).
 * Admin có thể chỉnh thời gian đếm ngược (timeLimitSec) và điều kiện qua màn ngay trên web (lưu vào bảng app_settings).
 */

export const DEFAULT_LEVEL_CONFIG = {
    lockProgression: true,
    levels: {
        1: {
            level: 1,
            mode: 'practice',
            name: 'Lv.1: Tập Phím',
            shortName: 'Lv.1 (1 chữ)',
            charLength: 1,
            timeLimitSec: 8,
            requiredSolved: 20,
            minAccuracyPct: 90,
            minDifficulty: 'easy',
            allowHints: true
        },
        2: {
            level: 2,
            mode: 'reflex',
            name: 'Lv.2: Phản Xạ',
            shortName: 'Lv.2 (3 chữ)',
            charLength: 3,
            timeLimitSec: 18,
            requiredSolved: 20,
            minAccuracyPct: 90,
            minDifficulty: 'medium',
            allowHints: true
        },
        3: {
            level: 3,
            mode: 'survival',
            name: 'Lv.3: Sinh Tồn',
            shortName: 'Lv.3 (6 chữ)',
            charLength: 6,
            timeLimitSec: 35,
            requiredSolved: 15,
            minAccuracyPct: 90,
            minDifficulty: 'medium',
            allowHints: false
        },
        4: {
            level: 4,
            mode: 'test',
            name: 'Lv.4: Thi Test',
            shortName: 'Lv.4 (Thi)',
            charLength: 6,
            timeLimitSec: 15,
            requiredSolved: 10,
            minAccuracyPct: 90,
            minDifficulty: 'medium',
            allowHints: false
        }
    }
};

export const DIFFICULTY_RANK = { easy: 1, medium: 2, hard: 3 };

export function isDifficultyQualifying(attemptDiff, minDiff) {
    const aRank = DIFFICULTY_RANK[attemptDiff] || 2;
    const minRank = DIFFICULTY_RANK[minDiff] || 1;
    return aRank >= minRank;
}

export const MODE_TO_LEVEL = {
    practice: 1,
    reflex: 2,
    survival: 3,
    test: 4
};

export const LEVEL_TO_MODE = {
    1: 'practice',
    2: 'reflex',
    3: 'survival',
    4: 'test'
};

export function sanitizeLevelConfig(raw) {
    const base = structuredClone(DEFAULT_LEVEL_CONFIG);
    if (!raw || typeof raw !== 'object') return base;
    if (typeof raw.lockProgression === 'boolean') {
        base.lockProgression = raw.lockProgression;
    }
    if (raw.levels && typeof raw.levels === 'object') {
        for (const lvl of [1, 2, 3, 4]) {
            const incoming = raw.levels[lvl] || raw.levels[String(lvl)];
            if (!incoming || typeof incoming !== 'object') continue;
            const sec = Number(incoming.timeLimitSec);
            const req = Number(incoming.requiredSolved);
            const acc = Number(incoming.minAccuracyPct);
            const diff = String(incoming.minDifficulty || '');
            if (Number.isFinite(sec) && sec >= 3 && sec <= 180) {
                base.levels[lvl].timeLimitSec = Math.round(sec);
            }
            if (Number.isFinite(req) && req >= 1 && req <= 10000) {
                base.levels[lvl].requiredSolved = Math.round(req);
            }
            if (Number.isFinite(acc) && acc >= 50 && acc <= 100) {
                base.levels[lvl].minAccuracyPct = Math.round(acc);
            }
            if (diff === 'easy' || diff === 'medium' || diff === 'hard') {
                base.levels[lvl].minDifficulty = diff;
            }
        }
    }
    return base;
}

export async function getLevelConfig(db) {
    const res = await db.execute({
        sql: 'SELECT value FROM app_settings WHERE key = ?',
        args: ['level_config']
    });
    if (res.rows.length === 0) return structuredClone(DEFAULT_LEVEL_CONFIG);
    try {
        return sanitizeLevelConfig(JSON.parse(String(res.rows[0].value || '{}')));
    } catch {
        return structuredClone(DEFAULT_LEVEL_CONFIG);
    }
}

export async function saveLevelConfig(db, config) {
    const clean = sanitizeLevelConfig(config);
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO app_settings (key, value, updated_at)
              VALUES ('level_config', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [JSON.stringify(clean), now]
    });
    return clean;
}

/**
 * Tính tiến độ riêng cho từng Level (1..4) dựa trên bảng attempt_logs & test_sessions thật trong DB.
 * - Tổng số mã đúng (solved): cộng dồn toàn bộ các mã đạt độ khó tối thiểu.
 * - Độ chính xác xét qua màn (accuracyPct): tính trên 30 lượt thử gần nhất (Rolling Window) của Level đó
 *   để thành viên mới tập sai lúc đầu không bị "nợ lỗi quá khứ" kẹt màn.
 */
export async function computePlayerLevelProgress(db, playerId, levelConfig, windowLimit = 30) {
    const [logsRes, passedTestRes] = await Promise.all([
        db.execute({
            sql: `SELECT mode, difficulty, is_correct, elapsed_ms
                  FROM attempt_logs
                  WHERE player_id = ?
                  ORDER BY created_at DESC, id DESC`,
            args: [playerId]
        }),
        db.execute({
            sql: `SELECT COUNT(*) AS pass_cnt, MAX(created_at) AS last_pass_at
                  FROM test_sessions
                  WHERE player_id = ? AND is_pass = 1`,
            args: [playerId]
        })
    ]);

    const testPassed = Number(passedTestRes.rows[0]?.pass_cnt || 0) > 0;
    const progress = {};
    let unlockedLevel = 1;

    for (const lvl of [1, 2, 3, 4]) {
        const cfg = levelConfig.levels[lvl];
        const minDiff = cfg.minDifficulty || 'easy';
        let solved = 0;
        let errors = 0;
        let sumMs = 0;
        let cntMs = 0;
        let recentTotal = 0;
        let recentSolved = 0;

        for (const r of logsRes.rows) {
            if (String(r.mode) !== cfg.mode) continue;
            if (!isDifficultyQualifying(String(r.difficulty || 'medium'), minDiff)) continue;
            const ok = Number(r.is_correct) === 1;
            const ms = Number(r.elapsed_ms || 0);

            if (ok) {
                solved += 1;
                if (ms <= 60000) {
                    sumMs += ms;
                    cntMs += 1;
                }
            } else {
                errors += 1;
            }

            if (recentTotal < windowLimit) {
                recentTotal += 1;
                if (ok) recentSolved += 1;
            }
        }

        const accuracyPct = recentTotal > 0 ? Number(((recentSolved / recentTotal) * 100).toFixed(1)) : 100;
        const avgSec = cntMs > 0 ? Number((sumMs / cntMs / 1000).toFixed(2)) : 0;

        const passed = lvl < 4
            ? (solved >= cfg.requiredSolved && accuracyPct >= cfg.minAccuracyPct)
            : testPassed;
        progress[lvl] = {
            level: lvl,
            mode: cfg.mode,
            solved,
            errors,
            accuracyPct,
            windowSize: recentTotal,
            avgSec,
            requiredSolved: cfg.requiredSolved,
            minAccuracyPct: cfg.minAccuracyPct,
            minDifficulty: minDiff,
            timeLimitSec: cfg.timeLimitSec,
            passed
        };
        if (lvl < 4 && passed && unlockedLevel === lvl) {
            unlockedLevel = lvl + 1;
        }
    }

    return {
        progress,
        computedLevel: unlockedLevel,
        completed: testPassed,
        completedAt: testPassed ? Number(passedTestRes.rows[0]?.last_pass_at || Date.now()) : 0
    };
}
