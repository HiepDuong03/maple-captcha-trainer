import { getDb } from '../lib/db.js';
import { extractCharMistakes, getDayKey } from '../lib/mistakes.js';
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

        const isCorrect = Boolean(body.isCorrect);
        const errorType = isCorrect ? '' : String(body.errorType || 'wrong');
        const typedInput = String(body.typedInput || '').trim().slice(0, 64);
        const elapsedMs = Math.max(0, Math.round(Number(body.elapsedMs || 0)));
        const mode = String(body.mode || 'reflex');
        const difficulty = String(body.difficulty || 'medium');
        const length = Number(body.length || [...target].length || 6);
        const now = Date.now();
        const dayKey = getDayKey(now);

        const db = await getDb();

        // Đảm bảo player tồn tại và cập nhật thống kê tổng hợp mới nhất
        await db.execute({
            sql: `INSERT INTO players (
                    id, name, solved, best_combo, total_time_ms,
                    wrong_count, reveal_count, timeout_count, accuracy_pct,
                    best_test_label, last_mode, last_difficulty, last_length,
                    last_active_at, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    solved = excluded.solved,
                    best_combo = MAX(players.best_combo, excluded.best_combo),
                    total_time_ms = excluded.total_time_ms,
                    wrong_count = excluded.wrong_count,
                    reveal_count = excluded.reveal_count,
                    timeout_count = excluded.timeout_count,
                    accuracy_pct = excluded.accuracy_pct,
                    best_test_label = CASE WHEN excluded.best_test_label != '' THEN excluded.best_test_label ELSE players.best_test_label END,
                    last_mode = excluded.last_mode,
                    last_difficulty = excluded.last_difficulty,
                    last_length = excluded.last_length,
                    last_active_at = excluded.last_active_at`,
            args: [
                playerId,
                playerName,
                Number(body.solved || 0),
                Number(body.bestCombo || 0),
                Number(body.totalTimeMs || 0),
                Number(body.wrongCount || 0),
                Number(body.revealCount || 0),
                Number(body.timeoutCount || 0),
                Number(body.accuracyPct ?? 100),
                String(body.bestTestLabel || ''),
                mode,
                difficulty,
                length,
                now,
                now
            ]
        });

        // Ghi log chi tiết từng lần thử
        const attemptRes = await db.execute({
            sql: `INSERT INTO attempt_logs (
                    player_id, mode, difficulty, target, typed_input,
                    is_correct, error_type, elapsed_ms, day_key, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                playerId,
                mode,
                difficulty,
                target,
                typedInput,
                isCorrect ? 1 : 0,
                errorType,
                elapsedMs,
                dayKey,
                now
            ]
        });

        const attemptId = Number(attemptRes.lastInsertRowid || 0);
        let mistakesRecorded = 0;

        // Nếu là lỗi -> phân tích từng ký tự sai / cặp nhầm lẫn (target -> typed)
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

        sendJson(res, 200, { ok: true, attemptId, mistakesRecorded });
    } catch (err) {
        console.error('[api/attempt]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
