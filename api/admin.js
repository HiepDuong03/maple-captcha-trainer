import { getDb, resolveDbConfig } from '../lib/db.js';
import { getDayKey, getRangeStartTs } from '../lib/mistakes.js';
import { sendJson, readJsonBody, getQueryParams, checkAdminAuth } from '../lib/http.js';

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
            sendJson(res, 400, { ok: false, error: 'Unsupported action or missing playerId' });
            return;
        }

        if (req.method === 'DELETE') {
            if (!auth.ok) {
                sendJson(res, 401, { ok: false, pinRequired: true, error: 'Sai hoặc thiếu mã PIN Admin' });
                return;
            }
            const { scope = 'player', playerId = '' } = getQueryParams(req);
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
            sendJson(res, 400, { ok: false, error: 'Missing playerId or scope=all' });
            return;
        }

        if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'Method not allowed' });
            return;
        }

        const { range = 'all', playerId = '' } = getQueryParams(req);
        const todayKey = getDayKey();
        const sinceTs = getRangeStartTs(range);

        // 1. Luôn trả danh sách tổng quan team (leaderboard + top 3 chữ yếu của từng người để gợi ý bổ túc)
        const [playersRes, todayCountsRes, playerWeakRes] = await Promise.all([
            db.execute('SELECT * FROM players ORDER BY solved DESC, last_active_at DESC'),
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
            })
        ]);

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

        const teamRecords = playersRes.rows.map((p) => {
            const solved = Number(p.solved || 0);
            const totalTimeMs = Number(p.total_time_ms || 0);
            return {
                id: p.id,
                userId: p.id,
                name: p.name,
                solved,
                bestCombo: Number(p.best_combo || 0),
                totalTimeMs,
                avgTimeSec: solved > 0 ? Number((totalTimeMs / solved / 1000).toFixed(2)) : 0,
                wrongCount: Number(p.wrong_count || 0),
                revealCount: Number(p.reveal_count || 0),
                timeoutCount: Number(p.timeout_count || 0),
                accuracyPct: Number(p.accuracy_pct ?? 100),
                todaySolved: todayMap.get(String(p.id)) || 0,
                todayKey,
                topWeakChars: weakMap.get(String(p.id)) || [],
                bestTestLabel: p.best_test_label || '',
                lastMode: p.last_mode,
                lastDifficulty: p.last_difficulty,
                lastLength: Number(p.last_length || 6),
                lastActiveAt: Number(p.last_active_at || 0)
            };
        });

        // Nếu ADMIN_PIN được đặt nhưng request chưa cung cấp đúng PIN -> chỉ trả leaderboard cơ bản + cờ locked
        if (!auth.ok) {
            sendJson(res, 200, {
                ok: true,
                dbMode: cfg.mode,
                pinRequired: true,
                adminUnlocked: false,
                teamRecords
            });
            return;
        }

        // 2. Phân tích lỗi cả team theo khoảng thời gian (today | 7d | 30d | all)
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

        // 3. Chi tiết riêng cho 1 thành viên nếu Admin chọn xem
        let playerDetail = null;
        if (playerId) {
            const [pMistakesRes, pPairsRes, pRecentErrorsRes, pTestsRes] = await Promise.all([
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
                })
            ]);

            playerDetail = {
                playerId,
                topHardChars: pMistakesRes.rows.map((r) => ({ char: r.expected_char, mistakes: Number(r.cnt) })),
                confusionPairs: pPairsRes.rows.map((r) => ({ expected: r.expected_char, actual: r.actual_char, count: Number(r.cnt) })),
                recentErrors: pRecentErrorsRes.rows.map((r) => ({
                    target: r.target,
                    typedInput: r.typed_input,
                    errorType: r.error_type,
                    mode: r.mode,
                    difficulty: r.difficulty,
                    elapsedSec: Number((Number(r.elapsed_ms || 0) / 1000).toFixed(2)),
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
            teamRecords,
            analytics,
            playerDetail
        });
    } catch (err) {
        console.error('[api/admin]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
