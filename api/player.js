import crypto from 'node:crypto';
import { getDb, resolveDbConfig } from '../lib/db.js';
import { getDayKey } from '../lib/mistakes.js';
import { normalizeNameKey, isValidPin, hashPin } from '../lib/auth.js';
import { getLevelConfig, computePlayerLevelProgress } from '../lib/levels.js';
import { sendJson, readJsonBody, getQueryParams } from '../lib/http.js';

async function loadPlayerProfile(db, playerRow, levelConfig) {
    const today = getDayKey();
    const [aggRes, todayRes, weakRes, levelInfo] = await Promise.all([
        db.execute({
            sql: `SELECT
                    SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS solved_cnt,
                    SUM(CASE WHEN is_correct = 0 AND error_type = 'wrong' THEN 1 ELSE 0 END) AS wrong_cnt,
                    SUM(CASE WHEN is_correct = 0 AND error_type = 'reveal' THEN 1 ELSE 0 END) AS reveal_cnt,
                    SUM(CASE WHEN is_correct = 0 AND error_type = 'timeout' THEN 1 ELSE 0 END) AS timeout_cnt,
                    SUM(CASE WHEN is_correct = 0 AND error_type = 'skip' THEN 1 ELSE 0 END) AS skip_cnt,
                    SUM(CASE WHEN is_correct = 1 THEN MIN(elapsed_ms, 60000) ELSE 0 END) AS clean_time_ms
                  FROM attempt_logs
                  WHERE player_id = ?`,
            args: [playerRow.id]
        }),
        db.execute({
            sql: 'SELECT COUNT(*) AS cnt FROM attempt_logs WHERE player_id = ? AND day_key = ? AND is_correct = 1',
            args: [playerRow.id, today]
        }),
        db.execute({
            sql: `SELECT expected_char, COUNT(*) AS cnt
                  FROM char_mistakes
                  WHERE player_id = ?
                  GROUP BY expected_char
                  ORDER BY cnt DESC
                  LIMIT 10`,
            args: [playerRow.id]
        }),
        computePlayerLevelProgress(db, playerRow.id, levelConfig, {
            persistedLevel: Number(playerRow.current_level || 1)
        })
    ]);

    const agg = aggRes.rows[0] || {};
    const solved = Number(agg.solved_cnt || 0);
    const wrongCount = Number(agg.wrong_cnt || 0) + Number(agg.skip_cnt || 0);
    const revealCount = Number(agg.reveal_cnt || 0);
    const timeoutCount = Number(agg.timeout_cnt || 0);
    const totalAttempts = solved + wrongCount + revealCount + timeoutCount;
    const accuracyPct = totalAttempts > 0 ? Number(((solved / totalAttempts) * 100).toFixed(1)) : 100;
    const totalTimeMs = Number(agg.clean_time_ms || 0);

    const weakChars = {};
    for (const row of weakRes.rows) {
        const cnt = Number(row.cnt || 0);
        weakChars[String(row.expected_char)] = { wrong: cnt, total: cnt, totalMs: cnt * 2500 };
    }

    const currentLevel = Math.max(Number(playerRow.current_level || 1), levelInfo.computedLevel);
    const completed = levelInfo.completed || Number(playerRow.completed_at || 0) > 0;

    return {
        userId: playerRow.id,
        name: playerRow.name,
        currentLevel,
        completed,
        completedAt: Number(playerRow.completed_at || levelInfo.completedAt || 0),
        levelProgress: levelInfo.progress,
        solved,
        bestCombo: Number(playerRow.best_combo || 0),
        totalTimeMs,
        wrongCount,
        revealCount,
        timeoutCount,
        accuracyPct,
        bestTestLabel: playerRow.best_test_label || '',
        lastMode: playerRow.last_mode || 'practice',
        lastDifficulty: playerRow.last_difficulty || 'medium',
        lastLength: Number(playerRow.last_length || 1),
        lastActiveAt: Number(playerRow.last_active_at || 0),
        todaySolved: Number(todayRes.rows[0]?.cnt || 0),
        weakChars
    };
}

export default async function handler(req, res) {
    try {
        const db = await getDb();
        const cfg = resolveDbConfig();
        const levelConfig = await getLevelConfig(db);

        if (req.method === 'GET') {
            const { id } = getQueryParams(req);
            if (!id) {
                sendJson(res, 200, { ok: true, dbMode: cfg.mode, levelConfig });
                return;
            }
            const playerRes = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [id] });
            if (playerRes.rows.length === 0) {
                sendJson(res, 200, { ok: true, dbMode: cfg.mode, levelConfig, profile: null });
                return;
            }
            const profile = await loadPlayerProfile(db, playerRes.rows[0], levelConfig);
            sendJson(res, 200, { ok: true, dbMode: cfg.mode, levelConfig, profile });
            return;
        }

        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const now = Date.now();

            // Heartbeat nhẹ mỗi 60s khi tab đang mở để Admin biết ai đang online
            if (body.action === 'ping') {
                const pid = String(body.userId || '').trim();
                if (!pid) {
                    sendJson(res, 400, { ok: false, error: 'Missing userId' });
                    return;
                }
                await db.execute({
                    sql: 'UPDATE players SET last_active_at = ? WHERE id = ?',
                    args: [now, pid]
                });
                sendJson(res, 200, { ok: true, lastActiveAt: now });
                return;
            }

            if (body.action === 'login') {
                const cleanName = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
                const pin = String(body.pin || '').trim();
                if (cleanName.length < 2) {
                    sendJson(res, 400, { ok: false, error: 'Tên phải từ 2 ký tự trở lên.' });
                    return;
                }
                if (!isValidPin(pin)) {
                    sendJson(res, 400, { ok: false, error: 'Mã PIN phải gồm đúng 4 chữ số (ví dụ: 1234).' });
                    return;
                }

                const nameKey = normalizeNameKey(cleanName);
                const pinHash = hashPin(nameKey, pin);

                const existingRes = await db.execute({
                    sql: 'SELECT * FROM players WHERE name_key = ? ORDER BY solved DESC, created_at ASC LIMIT 1',
                    args: [nameKey]
                });

                if (existingRes.rows.length > 0) {
                    const existing = existingRes.rows[0];
                    const storedHash = String(existing.pin_hash || '');

                    if (!storedHash) {
                        await db.execute({
                            sql: 'UPDATE players SET name = ?, pin_hash = ?, last_active_at = ? WHERE id = ?',
                            args: [cleanName, pinHash, now, existing.id]
                        });
                        const refreshed = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [existing.id] });
                        const profile = await loadPlayerProfile(db, refreshed.rows[0], levelConfig);
                        sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'claimed', levelConfig, profile });
                        return;
                    }

                    if (storedHash !== pinHash) {
                        sendJson(res, 401, {
                            ok: false,
                            code: 'WRONG_PIN',
                            error: 'Tên này đã tồn tại và mã PIN 4 số không đúng. Nếu quên PIN, nhờ Admin bấm Reset PIN.'
                        });
                        return;
                    }

                    await db.execute({
                        sql: 'UPDATE players SET name = ?, last_active_at = ? WHERE id = ?',
                        args: [cleanName, now, existing.id]
                    });
                    const profile = await loadPlayerProfile(db, { ...existing, name: cleanName, last_active_at: now }, levelConfig);
                    sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'login', levelConfig, profile });
                    return;
                }

                const newId = 'p-' + crypto.randomUUID().slice(0, 10);
                await db.execute({
                    sql: `INSERT INTO players (
                            id, name, name_key, pin_hash, current_level, completed_at,
                            solved, best_combo, total_time_ms,
                            wrong_count, reveal_count, timeout_count, accuracy_pct,
                            best_test_label, last_mode, last_difficulty, last_length,
                            last_active_at, created_at
                          ) VALUES (?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 100, '', 'practice', 'medium', 1, ?, ?)`,
                    args: [newId, cleanName, nameKey, pinHash, now, now]
                });

                const createdRes = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [newId] });
                const profile = await loadPlayerProfile(db, createdRes.rows[0], levelConfig);
                sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'register', levelConfig, profile });
                return;
            }

            // Upsert cơ bản cho hồ sơ đang hoạt động (không ghi đè tổng solved/time từ client)
            const id = String(body.userId || '').trim();
            const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
            if (!id || name.length < 2) {
                sendJson(res, 400, { ok: false, error: 'Missing userId or valid name (>= 2 chars)' });
                return;
            }

            const nameKey = normalizeNameKey(name);
            await db.execute({
                sql: `INSERT INTO players (
                        id, name, name_key, pin_hash, current_level, completed_at,
                        best_combo, best_test_label, last_mode, last_difficulty, last_length,
                        last_active_at, created_at
                      ) VALUES (?, ?, ?, '', 1, 0, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        name_key = CASE WHEN players.name_key = '' THEN excluded.name_key ELSE players.name_key END,
                        best_combo = MAX(players.best_combo, excluded.best_combo),
                        best_test_label = CASE WHEN excluded.best_test_label != '' THEN excluded.best_test_label ELSE players.best_test_label END,
                        last_mode = excluded.last_mode,
                        last_difficulty = excluded.last_difficulty,
                        last_length = excluded.last_length,
                        last_active_at = excluded.last_active_at`,
                args: [
                    id,
                    name,
                    nameKey,
                    Number(body.bestCombo || 0),
                    String(body.bestTestLabel || ''),
                    String(body.lastMode || 'practice'),
                    String(body.lastDifficulty || 'medium'),
                    Number(body.lastLength || 1),
                    now,
                    now
                ]
            });

            sendJson(res, 200, { ok: true, dbMode: cfg.mode, userId: id });
            return;
        }

        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (err) {
        console.error('[api/player]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
