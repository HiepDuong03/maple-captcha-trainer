import crypto from 'node:crypto';

/**
 * Chuẩn hóa tên để so khớp không phân biệt hoa/thường và khoảng trắng thừa.
 * Ví dụ: "  Thành  Nguyễn " -> "thành nguyễn"
 */
export function normalizeNameKey(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

export function isValidPin(pin) {
    return /^\d{4}$/.test(String(pin || '').trim());
}

/**
 * Hash mã PIN 4 số bằng SHA-256 kèm salt cố định theo nameKey (không lưu PIN dạng plaintext trong DB).
 */
export function hashPin(nameKey, pin) {
    const cleanPin = String(pin || '').trim();
    const pepper = process.env.PIN_PEPPER || 'maple-captcha-trainer-v2';
    return crypto
        .createHash('sha256')
        .update(`${pepper}:${nameKey}:${cleanPin}`)
        .digest('hex');
}
