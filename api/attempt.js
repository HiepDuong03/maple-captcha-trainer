import { getDb } from '../lib/db.js';
import { extractCharMistakes, getDayKey } from '../lib/mistakes.js';
import { normalizeNameKey } from '../lib/auth.js';
import { getLevelConfig, computePlayerLevelProgress, MODE_TO_LEVEL } from '../lib/levels.js';
import { sendJson, readJsonBody } from '../lib/http.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }

    try {
        const body = await readJsonBody(req);
        const playerId = String(body.userId || '').trim();
        const playerName = String(body.name || '').trim().slice(0, 32);
        const target = String(body.target || '').trim();

        if (!playerId || !playerName || !target) {
            sendJson(res, 400, { ok: false, error: 'Missing userId, name, or target' });
            return;
        }

        const db = await getDb();
        const levelConfig = await getLevelConfig(db);

        const isCorrect = Boolean(body.isCorrect);
        const errorType = isCorrect ? '' : String(body.errorType || 'wrong');
        const typedInput = String(body.typedInput || '').trim().slice(0, 64);
        const mode = String(body.mode || 'practice');
        const lvlNum = MODE_TO_LEVEL[mode] || 1;

        // Chặn phía server nếu Level đang bị khóa (tránh tab cũ chưa F5 gửi nhầm bài lên Level cao hơn)
        if (levelConfig.lockProgression && lvlNum > 1) {
            const curRes = await db.execute({ sql: 'SELECT current_level FROM players WHERE id = ?', args: [playerId] });
            let allowedLevel = curRes.rows.length > 0 ? Number(curRes.rows[0].current_level || 1) : 1;
            if (lvlNum > allowedLevel && curRes.rows.length > 0) {
                const info = await computePlayerLevelProgress(db, playerId, levelConfig);
                allowedLevel = Math.max(allowedLevel, info.computedLevel);
            }
            if (lvlNum > allowedLevel) {
                sendJson(res, 403, {
                    ok: false,
                    code: 'LEVEL_LOCKED',
                    allowedLevel,
                    levelConfig,
                    error: `Chưa mở khóa Level ${lvlNum}. Vui lòng hoàn thành Level ${allowedLevel} trước.`
                });
                return;
            }
        }
        const maxAllowedMs = (levelConfig.levels[lvlNum]?.timeLimitSec || 35) * 1000;
        // Chặn thời gian AFK: không bao giờ ghi nhận elapsedMs vượt quá thời gian giới hạn của Level
        const rawElapsedMs = Math.max(100, Math.round(Number(body.elapsedMs || 0)));
        const elapsedMs = Math.min(rawElapsedMs, maxAllowedMs);

        const difficulty = String(body.difficulty || 'medium');
        const length = Number(body.length || [...target].length || 1);
        const now = Date.now();
        const dayKey = getDayKey(now);
        const nameKey = normalizeNameKey(playerName);

        // 1. Đảm bảo player tồn tại trước khi ghi log
        await db.execute({
            sql: `INSERT INTO players (
                    id, name, name_key, pin_hash, current_level, completed_at,
                    best_combo, last_mode, last_difficulty, last_length, last_active_at, created_at
                  ) VALUES (?, ?, ?, '', 1, 0, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    name_key = CASE WHEN players.name_key = '' THEN excluded.name_key ELSE players.name_key END,
                    best_combo = MAX(players.best_combo, excluded.best_combo),
                    last_mode = excluded.last_mode,
                    last_difficulty = excluded.last_difficulty,
                    last_length = excluded.last_length,
                    last_active_at = excluded.last_active_at`,
            args: [playerId, playerName, nameKey, Number(body.bestCombo || 0), mode, difficulty, length, now, now]
        });

        // 2. Ghi log chi tiết từng lần thử
        const attemptRes = await db.execute({
            sql: `INSERT INTO attempt_logs (
                    player_id, mode, difficulty, target, typed_input,
                    is_correct, error_type, elapsed_ms, day_key, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [playerId, mode, difficulty, target, typedInput, isCorrect ? 1 : 0, errorType, elapsedMs, dayKey, now]
        });

        const attemptId = Number(attemptRes.lastInsertRowid || 0);
        let mistakesRecorded = 0;

        if (!isCorrect) {
            const mistakes = extractCharMistakes(target, typedInput, errorType);
            if (mistakes.length > 0) {
                const batchStmts = mistakes.map((m) => ({
                    sql: `INSERT INTO char_mistakes (
                            player_id, attempt_id, expected_char, actual_char,
                            error_type, day_key, created_at
                          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    args: [playerId, attemptId, m.expectedChar, m.actualChar, errorType, dayKey, now]
                }));
                await db.batch(batchStmts, 'write');
                mistakesRecorded = mistakes.length;
            }
        }

        // 3. Tính lại toàn bộ chỉ số & Level trực tiếp từ SQL (chống lệch dữ liệu giữa nhiều tab/thiết bị)
        const [prevPlayerRes, aggRes, levelInfo] = await Promise.all([
            db.execute({ sql: 'SELECT current_level FROM players WHERE id = ?', args: [playerId] }),
            db.execute({
                sql: `SELECT
                        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS solved_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type IN ('wrong', 'skip') THEN 1 ELSE 0 END) AS wrong_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'reveal' THEN 1 ELSE 0 END) AS reveal_cnt,
                        SUM(CASE WHEN is_correct = 0 AND error_type = 'timeout' THEN 1 ELSE 0 END) AS timeout_cnt,
                        SUM(CASE WHEN is_correct = 1 THEN MIN(elapsed_ms, 60000) ELSE 0 END) AS clean_time_ms
                      FROM attempt_logs
                      WHERE player_id = ?`,
                args: [playerId]
            }),
            computePlayerLevelProgress(db, playerId, levelConfig)
        ]);

        const prevLevel = Number(prevPlayerRes.rows[0]?.current_level || 1);
        const newLevel = Math.max(prevLevel, levelInfo.computedLevel);
        const leveledUp = newLevel > prevLevel;

        const agg = aggRes.rows[0] || {};
        const solved = Number(agg.solved_cnt || 0);
        const wrongCount = Number(agg.wrong_cnt || 0);
        const revealCount = Number(agg.reveal_cnt || 0);
        const timeoutCount = Number(agg.timeout_cnt || 0);
        const total = solved + wrongCount + revealCount + timeoutCount;
        const accuracyPct = total > 0 ? Number(((solved / total) * 100).toFixed(1)) : 100;
        const totalTimeMs = Number(agg.clean_time_ms || 0);

        await db.execute({
            sql: `UPDATE players
                  SET solved = ?, total_time_ms = ?, wrong_count = ?, reveal_count = ?,
                      timeout_count = ?, accuracy_pct = ?, current_level = ?,
                      completed_at = CASE WHEN ? > 0 AND completed_at = 0 THEN ? ELSE completed_at END
                  WHERE id = ?`,
            args: [solved, totalTimeMs, wrongCount, revealCount, timeoutCount, accuracyPct, newLevel, levelInfo.completedAt, levelInfo.completedAt, playerId]
        });

        sendJson(res, 200, {
            ok: true,
            attemptId,
            mistakesRecorded,
            currentLevel: newLevel,
            leveledUp,
            completed: levelInfo.completed,
            levelProgress: levelInfo.progress,
            summary: { solved, wrongCount, revealCount, timeoutCount, accuracyPct, totalTimeMs }
        });
    } catch (err) {
        console.error('[api/attempt]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
