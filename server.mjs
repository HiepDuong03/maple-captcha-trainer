/**
 * Local dev server chạy cả Frontend static + 4 Vercel API endpoints (/api/*) trên 1 cổng duy nhất.
 * Giúp test 100% giống môi trường Vercel ngay trên máy cá nhân với SQLite local (file:./data/trainer.db)
 * hoặc Turso cloud (nếu điền TURSO_DATABASE_URL trong .env).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import playerHandler from './api/player.js';
import attemptHandler from './api/attempt.js';
import testSessionHandler from './api/test-session.js';
import adminHandler from './api/admin.js';
import { resolveDbConfig } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);

// Nạp .env cục bộ nếu có (không cần thêm thư viện ngoài)
function loadLocalEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = val;
    }
}
loadLocalEnv();

const API_ROUTES = {
    '/api/player': playerHandler,
    '/api/attempt': attemptHandler,
    '/api/test-session': testSessionHandler,
    '/api/admin': adminHandler
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const pathname = parsed.pathname;

    if (API_ROUTES[pathname]) {
        await API_ROUTES[pathname](req, res);
        return;
    }

    // Chặn truy cập trực tiếp vào file nhạy cảm (.env, data/, lib/, server.mjs)
    if (
        pathname.startsWith('/data/') ||
        pathname.startsWith('/lib/') ||
        pathname.startsWith('/api/') ||
        pathname === '/.env' ||
        pathname === '/server.mjs'
    ) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const fullPath = path.resolve(__dirname, relPath);
    if (!fullPath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(fullPath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    const dbCfg = resolveDbConfig();
    console.log(`Maple Captcha Trainer running at http://127.0.0.1:${PORT} (DB mode: ${dbCfg.mode})`);
});
