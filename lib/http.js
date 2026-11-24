/**
 * Helper đọc JSON body và trả JSON response dùng chung cho cả Vercel Serverless Functions và local dev server.
 */
export function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(statusCode).json(payload);
        return;
    }
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') {
        return req.body;
    }
    if (typeof req.body === 'string' && req.body.length > 0) {
        return JSON.parse(req.body);
    }
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
}

export function getQueryParams(req) {
    if (req.query && typeof req.query === 'object') {
        return req.query;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const params = {};
    for (const [k, v] of url.searchParams.entries()) {
        params[k] = v;
    }
    return params;
}

export function checkAdminAuth(req) {
    const expectedPin = (process.env.ADMIN_PIN || '').trim();
    if (!expectedPin) {
        return { ok: true, pinRequired: false };
    }
    const providedPin = String(req.headers?.['x-admin-pin'] || getQueryParams(req).pin || '').trim();
    if (providedPin === expectedPin) {
        return { ok: true, pinRequired: true };
    }
    return { ok: false, pinRequired: true };
}
