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
            allowHints: false
        }
    }
};

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
            if (Number.isFinite(sec) && sec >= 3 && sec <= 120) {
                base.levels[lvl].timeLimitSec = Math.round(sec);
            }
            if (Number.isFinite(req) && req >= 1 && req <= 200) {
                base.levels[lvl].requiredSolved = Math.round(req);
            }
            if (Number.isFinite(acc) && acc >= 50 && acc <= 100) {
                base.levels[lvl].minAccuracyPct = Math.round(acc);
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
 * Tự động loại bỏ outlier AFK (> 60s) để số TB/mã luôn phản ánh đúng thực lực.
 */
export async function computePlayerLevelProgress(db, playerId, levelConfig) {
    const [modeStatsRes, passedTestRes] = await Promise.all([
        db.execute({
            sql: `SELECT
                    mode,
                    SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS solved_cnt,
                    SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS error_cnt,
                    AVG(CASE WHEN is_correct = 1 AND elapsed_ms <= 60000 THEN elapsed_ms END) AS avg_ms
                  FROM attempt_logs
                  WHERE player_id = ?
                  GROUP BY mode`,
            args: [playerId]
        }),
        db.execute({
            sql: `SELECT COUNT(*) AS pass_cnt, MAX(created_at) AS last_pass_at
                  FROM test_sessions
                  WHERE player_id = ? AND is_pass = 1`,
            args: [playerId]
        })
    ]);

    const byMode = new Map();
    for (const r of modeStatsRes.rows) {
        const solved = Number(r.solved_cnt || 0);
        const errors = Number(r.error_cnt || 0);
        const total = solved + errors;
        const acc = total > 0 ? Number(((solved / total) * 100).toFixed(1)) : 100;
        const avgSec = r.avg_ms ? Number((Number(r.avg_ms) / 1000).toFixed(2)) : 0;
        byMode.set(String(r.mode), { solved, errors, accuracyPct: acc, avgSec });
    }

    const testPassed = Number(passedTestRes.rows[0]?.pass_cnt || 0) > 0;
    const progress = {};
    let unlockedLevel = 1;

    for (const lvl of [1, 2, 3, 4]) {
        const cfg = levelConfig.levels[lvl];
        const st = byMode.get(cfg.mode) || { solved: 0, errors: 0, accuracyPct: 100, avgSec: 0 };
        const passed = lvl < 4
            ? (st.solved >= cfg.requiredSolved && st.accuracyPct >= cfg.minAccuracyPct)
            : testPassed;
        progress[lvl] = {
            level: lvl,
            mode: cfg.mode,
            solved: st.solved,
            errors: st.errors,
            accuracyPct: st.accuracyPct,
            avgSec: st.avgSec,
            requiredSolved: cfg.requiredSolved,
            minAccuracyPct: cfg.minAccuracyPct,
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
