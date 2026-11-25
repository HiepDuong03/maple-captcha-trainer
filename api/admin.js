import { getDb, resolveDbConfig } from '../lib/db.js';
import { getDayKey, getRangeStartTs } from '../lib/mistakes.js';
import { getLevelConfig, saveLevelConfig, computePlayerLevelProgress, isDifficultyQualifying } from '../lib/levels.js';
import { sendJson, readJsonBody, getQueryParams, checkAdminAuth } from '../lib/http.js';

async function resyncPlayersFromLogs(db, levelConfig) {
    const playersRes = await db.execute('SELECT id FROM players');
    for (const row of playersRes.rows) {
        const pid = String(row.id);
        const [aggRes, levelInfo] = await Promise.all([
            db.execute({
                sql: `SELECT
                        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS solved_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type IN ('wrong', 'skip') THEN 1 ELSE 0 END) AS wrong_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'reveal' THEN 1 ELSE 0 END) AS reveal_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'timeout' THEN 1 ELSE 0 END) AS timeout_cnt,
                        SUM(CASE WHEN is_correct = 1 THEN MIN(elapsed_ms, 60000) ELSE 0 END) AS clean_time_ms
                      FROM attempt_logs
                      WHERE player_id = ?`,
                args: [pid]
            }),
            computePlayerLevelProgress(db, pid, levelConfig)
        ]);
        const a = aggRes.rows[0] || {};
        const solved = Number(a.solved_cnt || 0);
        const wrongCount = Number(a.wrong_cnt || 0);
        const revealCount = Number(a.reveal_cnt || 0);
        const timeoutCount = Number(a.timeout_cnt || 0);
        const total = solved + wrongCount + revealCount + timeoutCount;
        const acc = total > 0 ? Number(((solved / total) * 100).toFixed(1)) : 100;
        const cleanTime = Number(a.clean_time_ms || 0);
        await db.execute({
            sql: `UPDATE players
                  SET solved = ?, total_time_ms = ?, wrong_count = ?, reveal_count = ?, timeout_count = ?,
                      accuracy_pct = ?, current_level = ?, completed_at = ?
                  WHERE id = ?`,
            args: [solved, cleanTime, wrongCount, revealCount, timeoutCount, acc, levelInfo.computedLevel, levelInfo.completedAt, pid]
        });
    }
}

export default async function handler(req, res) {
    try {
        const db = await getDb();
        const cfg = resolveDbConfig();
        const auth = checkAdminAuth(req);

        if (req.method === 'PATCH') {
            if (!auth.ok) {
                sendJson(res, 401, { ok: false, pinRequired: true, error: 'Sai hoặc thiếu mã PIN Admin' });
                return;
            }
            const body = await readJsonBody(req);
            if (body.action === 'reset-pin' && body.playerId) {
                await db.execute({
                    sql: `UPDATE players SET pin_hash = '' WHERE id = ?`,
                    args: [String(body.playerId)]
                });
                sendJson(res, 200, { ok: true, resetPinFor: String(body.playerId) });
                return;
            }
            if (body.action === 'update-settings' && body.levelConfig) {
                const saved = await saveLevelConfig(db, body.levelConfig);
                sendJson(res, 200, { ok: true, levelConfig: saved });
                return;
            }
            if (body.action === 'set-level' && body.playerId) {
                const lvl = Math.max(1, Math.min(4, Math.round(Number(body.level || 1))));
                await db.execute({
                    sql: `UPDATE players SET current_level = ? WHERE id = ?`,
                    args: [lvl, String(body.playerId)]
                });
                sendJson(res, 200, { ok: true, playerId: String(body.playerId), currentLevel: lvl });
                return;
            }
            sendJson(res, 400, { ok: false, error: 'Unsupported action or missing fields' });
            return;
        }

        if (req.method === 'DELETE') {
            if (!auth.ok) {
                sendJson(res, 401, { ok: false, pinRequired: true, error: 'Sai hoặc thiếu mã PIN Admin' });
                return;
            }
            const { scope = 'player', playerId = '' } = getQueryParams(req);
            if (scope === 'today') {
                const todayKey = getDayKey();
                await db.batch([
                    { sql: 'DELETE FROM char_mistakes WHERE day_key = ?', args: [todayKey] },
                    { sql: 'DELETE FROM attempt_logs WHERE day_key = ?', args: [todayKey] },
                    { sql: 'DELETE FROM test_sessions WHERE day_key = ?', args: [todayKey] }
                ], 'write');
                const levelConfig = await getLevelConfig(db);
                await resyncPlayersFromLogs(db, levelConfig);
                sendJson(res, 200, { ok: true, cleared: 'today', dayKey: todayKey });
                return;
            }
            if (scope === 'all') {
                await db.batch([
                    'DELETE FROM char_mistakes',
                    'DELETE FROM attempt_logs',
                    'DELETE FROM test_sessions',
                    'DELETE FROM players'
                ], 'write');
                sendJson(res, 200, { ok: true, cleared: 'all' });
                return;
            }
            if (playerId) {
                await db.batch([
                    { sql: 'DELETE FROM char_mistakes WHERE player_id = ?', args: [playerId] },
                    { sql: 'DELETE FROM attempt_logs WHERE player_id = ?', args: [playerId] },
                    { sql: 'DELETE FROM test_sessions WHERE player_id = ?', args: [playerId] },
                    { sql: 'DELETE FROM players WHERE id = ?', args: [playerId] }
                ], 'write');
                sendJson(res, 200, { ok: true, cleared: playerId });
                return;
            }
            sendJson(res, 400, { ok: false, error: 'Missing playerId or valid scope' });
            return;
        }

        if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'Method not allowed' });
            return;
        }

        const { range = 'all', playerId = '' } = getQueryParams(req);
        const todayKey = getDayKey();
        const sinceTs = getRangeStartTs(range);
        const levelConfig = await getLevelConfig(db);

        // Tính trực tiếp thống kê chuẩn từ attempt_logs theo khoảng thời gian (loại bỏ outlier AFK > 60s)
        const [playersRes, rangeAggRes, todayCountsRes, playerWeakRes, passedTestsRes, allAttemptsRes] = await Promise.all([
            db.execute('SELECT * FROM players ORDER BY completed_at DESC, current_level DESC, solved DESC'),
            db.execute({
                sql: `SELECT
                        player_id,
                        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS solved_cnt,
                        SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS err_cnt,
                        SUM(CASE WHEN is_correct = 1 THEN MIN(elapsed_ms, 60000) ELSE 0 END) AS clean_time_ms,
                        AVG(CASE WHEN is_correct = 1 AND elapsed_ms <= 60000 THEN elapsed_ms END) AS avg_ms
                      FROM attempt_logs
                      WHERE created_at >= ?
                      GROUP BY player_id`,
                args: [sinceTs]
            }),
            db.execute({
                sql: `SELECT player_id, COUNT(*) AS cnt
                      FROM attempt_logs
                      WHERE day_key = ? AND is_correct = 1
                      GROUP BY player_id`,
                args: [todayKey]
            }),
            db.execute({
                sql: `SELECT player_id, expected_char, COUNT(*) AS cnt
                      FROM char_mistakes
                      WHERE created_at >= ?
                      GROUP BY player_id, expected_char
                      ORDER BY player_id, cnt DESC`,
                args: [sinceTs]
            }),
            db.execute({
                sql: `SELECT player_id, COUNT(*) AS pass_cnt
                      FROM test_sessions
                      WHERE is_pass = 1
                      GROUP BY player_id`
            }),
            db.execute({
                sql: `SELECT player_id, mode, difficulty, is_correct, elapsed_ms
                      FROM attempt_logs
                      WHERE created_at >= ?
                      ORDER BY created_at DESC, id DESC`,
                args: [sinceTs]
            })
        ]);

        const attemptsByPlayer = new Map();
        for (const r of allAttemptsRes.rows) {
            const pid = String(r.player_id);
            let list = attemptsByPlayer.get(pid);
            if (!list) {
                list = [];
                attemptsByPlayer.set(pid, list);
            }
            list.push(r);
        }

        const rangeMap = new Map();
        for (const r of rangeAggRes.rows) {
            rangeMap.set(String(r.player_id), {
                solved: Number(r.solved_cnt || 0),
                errors: Number(r.err_cnt || 0),
                cleanTimeMs: Number(r.clean_time_ms || 0),
                avgSec: r.avg_ms ? Number((Number(r.avg_ms) / 1000).toFixed(2)) : 0
            });
        }

        const todayMap = new Map();
        for (const row of todayCountsRes.rows) {
            todayMap.set(String(row.player_id), Number(row.cnt || 0));
        }

        const weakMap = new Map();
        for (const row of playerWeakRes.rows) {
            const pid = String(row.player_id);
            const list = weakMap.get(pid) || [];
            if (list.length < 3) {
                list.push({ char: String(row.expected_char), mistakes: Number(row.cnt || 0) });
                weakMap.set(pid, list);
            }
        }

        const passedSet = new Set(
            passedTestsRes.rows.filter((r) => Number(r.pass_cnt || 0) > 0).map((r) => String(r.player_id))
        );

        const teamRecords = playersRes.rows.map((p) => {
            const pid = String(p.id);
            const rStats = rangeMap.get(pid) || { solved: 0, errors: 0, cleanTimeMs: 0, avgSec: 0 };
            const totalRange = rStats.solved + rStats.errors;
            const acc = totalRange > 0 ? Number(((rStats.solved / totalRange) * 100).toFixed(1)) : 100;
            const completed = Number(p.completed_at || 0) > 0 || passedSet.has(pid);
            const curLevel = Number(p.current_level || 1);
            const lvlCfg = levelConfig.levels[curLevel] || levelConfig.levels[1];
            const pAttempts = attemptsByPlayer.get(pid) || [];

            let lvlSolved = 0;
            let lvlErrors = 0;
            let lvlSumMs = 0;
            let lvlCntMs = 0;
            let recentTotal = 0;
            let recentSolved = 0;
            for (const a of pAttempts) {
                if (String(a.mode) !== lvlCfg.mode) continue;
                if (!isDifficultyQualifying(String(a.difficulty || 'medium'), lvlCfg.minDifficulty || 'easy')) continue;
                const ok = Number(a.is_correct) === 1;
                const ms = Number(a.elapsed_ms || 0);
                if (ok) {
                    lvlSolved += 1;
                    if (ms <= 60000) {
                        lvlSumMs += ms;
                        lvlCntMs += 1;
                    }
                } else {
                    lvlErrors += 1;
                }
                if (recentTotal < 30) {
                    recentTotal += 1;
                    if (ok) recentSolved += 1;
                }
            }

            const currentLevelStats = {
                level: curLevel,
                solved: lvlSolved,
                errors: lvlErrors,
                requiredSolved: lvlCfg.requiredSolved,
                accuracyPct: recentTotal > 0 ? Number(((recentSolved / recentTotal) * 100).toFixed(1)) : 100,
                windowSize: recentTotal,
                avgSec: lvlCntMs > 0 ? Number((lvlSumMs / lvlCntMs / 1000).toFixed(2)) : 0
            };

            return {
                id: pid,
                userId: pid,
                name: p.name,
                currentLevel: curLevel,
                currentLevelStats,
                completed,
                completedAt: Number(p.completed_at || 0),
                solved: rStats.solved,
                errors: rStats.errors,
                bestCombo: Number(p.best_combo || 0),
                totalTimeMs: rStats.cleanTimeMs,
                avgTimeSec: rStats.avgSec,
                accuracyPct: acc,
                todaySolved: todayMap.get(pid) || 0,
                todayKey,
                topWeakChars: weakMap.get(pid) || [],
                bestTestLabel: p.best_test_label || '',
                lastMode: p.last_mode,
                lastDifficulty: p.last_difficulty,
                lastLength: Number(p.last_length || 1),
                lastActiveAt: Number(p.last_active_at || 0)
            };
        });

        if (!auth.ok) {
            sendJson(res, 200, {
                ok: true,
                dbMode: cfg.mode,
                pinRequired: true,
                adminUnlocked: false,
                levelConfig,
                teamRecords
            });
            return;
        }

        const [errorBreakdownRes, topCharsRes, confusionPairsRes, recentTestsRes] = await Promise.all([
            db.execute({
                sql: `SELECT
                        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'wrong' THEN 1 ELSE 0 END) AS wrong_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'reveal' THEN 1 ELSE 0 END) AS reveal_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'timeout' THEN 1 ELSE 0 END) AS timeout_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'skip' THEN 1 ELSE 0 END) AS skip_cnt
                      FROM attempt_logs
                      WHERE created_at >= ?`,
                args: [sinceTs]
            }),
            db.execute({
                sql: `SELECT
                        expected_char,
                        COUNT(*) AS mistake_count,
                        COUNT(DISTINCT player_id) AS affected_players
                      FROM char_mistakes
                      WHERE created_at >= ?
                      GROUP BY expected_char
                      ORDER BY mistake_count DESC, affected_players DESC
                      LIMIT 12`,
                args: [sinceTs]
            }),
            db.execute({
                sql: `SELECT
                        expected_char,
                        actual_char,
                        COUNT(*) AS pair_count,
                        COUNT(DISTINCT player_id) AS affected_players
                      FROM char_mistakes
                      WHERE created_at >= ? AND actual_char != ''
                      GROUP BY expected_char, actual_char
                      ORDER BY pair_count DESC
                      LIMIT 12`,
                args: [sinceTs]
            }),
            db.execute({
                sql: `SELECT ts.*, p.name AS player_name
                      FROM test_sessions ts
                      LEFT JOIN players p ON p.id = ts.player_id
                      WHERE ts.created_at >= ?
                      ORDER BY ts.created_at DESC
                      LIMIT 25`,
                args: [sinceTs]
            })
        ]);

        const eb = errorBreakdownRes.rows[0] || {};
        const analytics = {
            range,
            breakdown: {
                correct: Number(eb.correct_cnt || 0),
                wrong: Number(eb.wrong_cnt || 0),
                reveal: Number(eb.reveal_cnt || 0),
                timeout: Number(eb.timeout_cnt || 0),
                skip: Number(eb.skip_cnt || 0)
            },
            topHardChars: topCharsRes.rows.map((r) => ({
                char: r.expected_char,
                mistakes: Number(r.mistake_count || 0),
                affectedPlayers: Number(r.affected_players || 0)
            })),
            confusionPairs: confusionPairsRes.rows.map((r) => ({
                expected: r.expected_char,
                actual: r.actual_char,
                count: Number(r.pair_count || 0),
                affectedPlayers: Number(r.affected_players || 0)
            })),
            recentTests: recentTestsRes.rows.map((r) => ({
                id: Number(r.id),
                playerId: r.player_id,
                playerName: r.player_name || r.player_id,
                totalQuestions: Number(r.total_questions),
                passedCount: Number(r.passed_count),
                failedCount: Number(r.failed_count),
                accuracyPct: Number(r.accuracy_pct),
                avgSec: Number(r.avg_sec),
                totalSec: Number(r.total_sec),
                isPass: Boolean(Number(r.is_pass)),
                missedTargets: JSON.parse(r.missed_targets || '[]'),
                createdAt: Number(r.created_at)
            }))
        };

        let playerDetail = null;
        if (playerId) {
            const pRowRes = await db.execute({ sql: 'SELECT current_level FROM players WHERE id = ?', args: [playerId] });
            const pCurrentLevel = Number(pRowRes.rows[0]?.current_level || 1);
            const [pMistakesRes, pPairsRes, pRecentErrorsRes, pTestsRes, pLevelInfo] = await Promise.all([
                db.execute({
                    sql: `SELECT expected_char, COUNT(*) AS cnt
                          FROM char_mistakes
                          WHERE player_id = ? AND created_at >= ?
                          GROUP BY expected_char
                          ORDER BY cnt DESC
                          LIMIT 10`,
                    args: [playerId, sinceTs]
                }),
                db.execute({
                    sql: `SELECT expected_char, actual_char, COUNT(*) AS cnt
                          FROM char_mistakes
                          WHERE player_id = ? AND created_at >= ? AND actual_char != ''
                          GROUP BY expected_char, actual_char
                          ORDER BY cnt DESC
                          LIMIT 8`,
                    args: [playerId, sinceTs]
                }),
                db.execute({
                    sql: `SELECT target, typed_input, error_type, mode, difficulty, elapsed_ms, created_at
                          FROM attempt_logs
                          WHERE player_id = ? AND is_correct = 0 AND created_at >= ?
                          ORDER BY created_at DESC
                          LIMIT 15`,
                    args: [playerId, sinceTs]
                }),
                db.execute({
                    sql: `SELECT * FROM test_sessions
                          WHERE player_id = ?
                          ORDER BY created_at DESC
                          LIMIT 15`,
                    args: [playerId]
                }),
                computePlayerLevelProgress(db, playerId, levelConfig, { persistedLevel: pCurrentLevel })
            ]);

            playerDetail = {
                playerId,
                levelProgress: pLevelInfo.progress,
                topHardChars: pMistakesRes.rows.map((r) => ({ char: r.expected_char, mistakes: Number(r.cnt) })),
                confusionPairs: pPairsRes.rows.map((r) => ({ expected: r.expected_char, actual: r.actual_char, count: Number(r.cnt) })),
                recentErrors: pRecentErrorsRes.rows.map((r) => ({
                    target: r.target,
                    typedInput: r.typed_input,
                    errorType: r.error_type,
                    mode: r.mode,
                    difficulty: r.difficulty,
                    elapsedSec: Number((Math.min(Number(r.elapsed_ms || 0), 60000) / 1000).toFixed(2)),
                    createdAt: Number(r.created_at)
                })),
                testHistory: pTestsRes.rows.map((r) => ({
                    totalQuestions: Number(r.total_questions),
                    passedCount: Number(r.passed_count),
                    accuracyPct: Number(r.accuracy_pct),
                    avgSec: Number(r.avg_sec),
                    isPass: Boolean(Number(r.is_pass)),
                    missedTargets: JSON.parse(r.missed_targets || '[]'),
                    createdAt: Number(r.created_at)
                }))
            };
        }

        sendJson(res, 200, {
            ok: true,
            dbMode: cfg.mode,
            pinRequired: auth.pinRequired,
            adminUnlocked: true,
            levelConfig,
            teamRecords,
            analytics,
            playerDetail
        });
    } catch (err) {
        console.error('[api/admin]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
