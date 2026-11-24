/**
 * Lớp kết nối Turso / LibSQL dùng `@libsql/client`.
 * - Trên Vercel: đọc `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
 * - Ở local dev / test: tự fallback sang file SQLite `file:./data/trainer.db` (hoặc `LOCAL_DB_URL`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let cachedClient = null;
let cachedUrl = null;
let schemaReady = false;

export function resolveDbConfig() {
    const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
    if (tursoUrl) {
        return {
            url: tursoUrl,
            authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined,
            mode: 'turso'
        };
    }

    const customLocal = (process.env.LOCAL_DB_URL || '').trim();
    if (customLocal) {
        return { url: customLocal, authToken: undefined, mode: 'local' };
    }

    const dataDir = path.join(PROJECT_ROOT, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbFile = path.join(dataDir, 'trainer.db').replace(/\\/g, '/');
    return {
        url: `file:${dbFile}`,
        authToken: undefined,
        mode: 'local'
    };
}

export function resetDbClientForTest() {
    if (cachedClient && typeof cachedClient.close === 'function') {
        cachedClient.close();
    }
    cachedClient = null;
    cachedUrl = null;
    schemaReady = false;
}

export async function getDb() {
    const cfg = resolveDbConfig();
    if (!cachedClient || cachedUrl !== cfg.url) {
        cachedClient = createClient({
            url: cfg.url,
            authToken: cfg.authToken
        });
        cachedUrl = cfg.url;
        schemaReady = false;
    }

    if (!schemaReady) {
        await ensureSchema(cachedClient);
        schemaReady = true;
    }

    return cachedClient;
}

async function ensureSchema(db) {
    const statements = [
        `CREATE TABLE IF NOT EXISTS players (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL DEFAULT '',
            pin_hash TEXT NOT NULL DEFAULT '',
            current_level INTEGER NOT NULL DEFAULT 1,
            completed_at INTEGER NOT NULL DEFAULT 0,
            solved INTEGER NOT NULL DEFAULT 0,
            best_combo INTEGER NOT NULL DEFAULT 0,
            total_time_ms INTEGER NOT NULL DEFAULT 0,
            wrong_count INTEGER NOT NULL DEFAULT 0,
            reveal_count INTEGER NOT NULL DEFAULT 0,
            timeout_count INTEGER NOT NULL DEFAULT 0,
            accuracy_pct REAL NOT NULL DEFAULT 100,
            best_test_label TEXT NOT NULL DEFAULT '',
            last_mode TEXT NOT NULL DEFAULT 'practice',
            last_difficulty TEXT NOT NULL DEFAULT 'medium',
            last_length INTEGER NOT NULL DEFAULT 1,
            last_active_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS attempt_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            target TEXT NOT NULL,
            typed_input TEXT NOT NULL DEFAULT '',
            is_correct INTEGER NOT NULL,
            error_type TEXT NOT NULL DEFAULT '',
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            day_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS char_mistakes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            attempt_id INTEGER,
            expected_char TEXT NOT NULL,
            actual_char TEXT NOT NULL DEFAULT '',
            error_type TEXT NOT NULL DEFAULT 'wrong',
            day_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS test_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            total_questions INTEGER NOT NULL,
            passed_count INTEGER NOT NULL,
            failed_count INTEGER NOT NULL,
            accuracy_pct REAL NOT NULL,
            avg_sec REAL NOT NULL,
            total_sec REAL NOT NULL,
            is_pass INTEGER NOT NULL,
            missed_targets TEXT NOT NULL DEFAULT '[]',
            day_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_attempts_player ON attempt_logs(player_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_attempts_day ON attempt_logs(day_key)`,
        `CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempt_logs(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_mistakes_pair ON char_mistakes(expected_char, actual_char)`,
        `CREATE INDEX IF NOT EXISTS idx_mistakes_player ON char_mistakes(player_id)`,
        `CREATE INDEX IF NOT EXISTS idx_mistakes_created ON char_mistakes(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_tests_player ON test_sessions(player_id, created_at DESC)`
    ];

    await db.batch(statements, 'write');

    // Migration an toàn cho DB đã tạo trước đó chưa có cột name_key / pin_hash
    const colsRes = await db.execute('PRAGMA table_info(players)');
    const colNames = new Set(colsRes.rows.map((r) => String(r.name)));
    if (!colNames.has('name_key')) {
        await db.execute(`ALTER TABLE players ADD COLUMN name_key TEXT NOT NULL DEFAULT ''`);
        await db.execute(`UPDATE players SET name_key = LOWER(TRIM(name)) WHERE name_key = ''`);
    }
    if (!colNames.has('pin_hash')) {
        await db.execute(`ALTER TABLE players ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''`);
    }
    if (!colNames.has('current_level')) {
        await db.execute(`ALTER TABLE players ADD COLUMN current_level INTEGER NOT NULL DEFAULT 1`);
    }
    if (!colNames.has('completed_at')) {
        await db.execute(`ALTER TABLE players ADD COLUMN completed_at INTEGER NOT NULL DEFAULT 0`);
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_players_name_key ON players(name_key)`);
}
