import crypto from 'node:crypto';
import { getDb, resolveDbConfig } from '../lib/db.js';
import { getDayKey } from '../lib/mistakes.js';
import { normalizeNameKey, isValidPin, hashPin } from '../lib/auth.js';
import { sendJson, readJsonBody, getQueryParams } from '../lib/http.js';

async function loadPlayerProfile(db, playerRow) {
    const today = getDayKey();
    const [todayRes, weakRes] = await Promise.all([
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
        })
    ]);

    const weakChars = {};
    for (const row of weakRes.rows) {
        const cnt = Number(row.cnt || 0);
        weakChars[String(row.expected_char)] = { wrong: cnt, total: cnt, totalMs: cnt * 2500 };
    }

    return {
        userId: playerRow.id,
        name: playerRow.name,
        solved: Number(playerRow.solved || 0),
        bestCombo: Number(playerRow.best_combo || 0),
        totalTimeMs: Number(playerRow.total_time_ms || 0),
        wrongCount: Number(playerRow.wrong_count || 0),
        revealCount: Number(playerRow.reveal_count || 0),
        timeoutCount: Number(playerRow.timeout_count || 0),
        accuracyPct: Number(playerRow.accuracy_pct ?? 100),
        bestTestLabel: playerRow.best_test_label || '',
        lastMode: playerRow.last_mode || 'reflex',
        lastDifficulty: playerRow.last_difficulty || 'medium',
        lastLength: Number(playerRow.last_length || 6),
        lastActiveAt: Number(playerRow.last_active_at || 0),
        todaySolved: Number(todayRes.rows[0]?.cnt || 0),
        weakChars
    };
}

export default async function handler(req, res) {
    try {
        const db = await getDb();
        const cfg = resolveDbConfig();

        if (req.method === 'GET') {
            const { id } = getQueryParams(req);
            if (!id) {
                sendJson(res, 200, { ok: true, dbMode: cfg.mode });
                return;
            }
            const playerRes = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [id] });
            if (playerRes.rows.length === 0) {
                sendJson(res, 200, { ok: true, dbMode: cfg.mode, profile: null });
                return;
            }
            const profile = await loadPlayerProfile(db, playerRes.rows[0]);
            sendJson(res, 200, { ok: true, dbMode: cfg.mode, profile });
            return;
        }

        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const now = Date.now();

            // Luồng Đăng nhập / Tạo hồ sơ bằng Tên + Mã PIN 4 số (gộp dữ liệu trên mọi thiết bị)
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

                    // Hồ sơ cũ chưa có PIN hoặc vừa được Admin Reset PIN -> gắn PIN mới và giữ nguyên toàn bộ dữ liệu
                    if (!storedHash) {
                        await db.execute({
                            sql: 'UPDATE players SET name = ?, pin_hash = ?, last_active_at = ? WHERE id = ?',
                            args: [cleanName, pinHash, now, existing.id]
                        });
                        const refreshed = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [existing.id] });
                        const profile = await loadPlayerProfile(db, refreshed.rows[0]);
                        sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'claimed', profile });
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
                    const profile = await loadPlayerProfile(db, { ...existing, name: cleanName, last_active_at: now });
                    sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'login', profile });
                    return;
                }

                // Tạo hồ sơ mới
                const newId = 'p-' + crypto.randomUUID().slice(0, 10);
                await db.execute({
                    sql: `INSERT INTO players (
                            id, name, name_key, pin_hash,
                            solved, best_combo, total_time_ms,
                            wrong_count, reveal_count, timeout_count, accuracy_pct,
                            best_test_label, last_mode, last_difficulty, last_length,
                            last_active_at, created_at
                          ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 100, '', 'reflex', 'medium', 6, ?, ?)`,
                    args: [newId, cleanName, nameKey, pinHash, now, now]
                });

                const createdRes = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [newId] });
                const profile = await loadPlayerProfile(db, createdRes.rows[0]);
                sendJson(res, 200, { ok: true, dbMode: cfg.mode, authMode: 'register', profile });
                return;
            }

            // Luồng đồng bộ thống kê của phiên đã đăng nhập
            const id = String(body.userId || '').trim();
            const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
            if (!id || name.length < 2) {
                sendJson(res, 400, { ok: false, error: 'Missing userId or valid name (>= 2 chars)' });
                return;
            }

            const nameKey = normalizeNameKey(name);
            await db.execute({
                sql: `INSERT INTO players (
                        id, name, name_key, pin_hash, solved, best_combo, total_time_ms,
                        wrong_count, reveal_count, timeout_count, accuracy_pct,
                        best_test_label, last_mode, last_difficulty, last_length,
                        last_active_at, created_at
                      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        name_key = CASE WHEN players.name_key = '' THEN excluded.name_key ELSE players.name_key END,
                        solved = MAX(players.solved, excluded.solved),
                        best_combo = MAX(players.best_combo, excluded.best_combo),
                        total_time_ms = MAX(players.total_time_ms, excluded.total_time_ms),
                        wrong_count = MAX(players.wrong_count, excluded.wrong_count),
                        reveal_count = MAX(players.reveal_count, excluded.reveal_count),
                        timeout_count = MAX(players.timeout_count, excluded.timeout_count),
                        accuracy_pct = excluded.accuracy_pct,
                        best_test_label = CASE WHEN excluded.best_test_label != '' THEN excluded.best_test_label ELSE players.best_test_label END,
                        last_mode = excluded.last_mode,
                        last_difficulty = excluded.last_difficulty,
                        last_length = excluded.last_length,
                        last_active_at = excluded.last_active_at`,
                args: [
                    id,
                    name,
                    nameKey,
                    Number(body.solved || 0),
                    Number(body.bestCombo || 0),
                    Number(body.totalTimeMs || 0),
                    Number(body.wrongCount || 0),
                    Number(body.revealCount || 0),
                    Number(body.timeoutCount || 0),
                    Number(body.accuracyPct ?? 100),
                    String(body.bestTestLabel || ''),
                    String(body.lastMode || 'reflex'),
                    String(body.lastDifficulty || 'medium'),
                    Number(body.lastLength || 6),
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
