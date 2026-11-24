import { getDb } from '../lib/db.js';
import { getDayKey } from '../lib/mistakes.js';
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
        if (!playerId || !playerName) {
            sendJson(res, 400, { ok: false, error: 'Missing userId or name' });
            return;
        }

        const now = Date.now();
        const dayKey = getDayKey(now);
        const db = await getDb();

        const missedTargets = Array.isArray(body.missedTargets) ? body.missedTargets : [];
        const label = String(body.label || '');
        const isPass = Boolean(body.isPass);

        const insertRes = await db.execute({
            sql: `INSERT INTO test_sessions (
                    player_id, total_questions, passed_count, failed_count,
                    accuracy_pct, avg_sec, total_sec, is_pass, missed_targets,
                    day_key, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                playerId,
                Number(body.totalQuestions || 10),
                Number(body.passedCount || 0),
                Number(body.failedCount || 0),
                Number(body.accuracyPct || 0),
                Number(body.avgSec || 0),
                Number(body.totalSec || 0),
                isPass ? 1 : 0,
                JSON.stringify(missedTargets),
                dayKey,
                now
            ]
        });

        await db.execute({
            sql: `UPDATE players
                  SET best_test_label = CASE WHEN ? = 1 OR best_test_label = '' THEN ? ELSE best_test_label END,
                      current_level = CASE WHEN ? = 1 THEN 4 ELSE current_level END,
                      completed_at = CASE WHEN ? = 1 AND completed_at = 0 THEN ? ELSE completed_at END,
                      last_active_at = ?
                  WHERE id = ?`,
            args: [isPass ? 1 : 0, label, isPass ? 1 : 0, isPass ? 1 : 0, now, now, playerId]
        });

        sendJson(res, 200, { ok: true, sessionId: Number(insertRes.lastInsertRowid || 0), completed: isPass });
    } catch (err) {
        console.error('[api/test-session]', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
}
