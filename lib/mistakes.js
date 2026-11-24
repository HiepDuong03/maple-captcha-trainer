/**
 * Tách lỗi theo từng ký tự giữa đáp án (`target`) và chuỗi người dùng gõ (`typedInput`).
 * Dùng cho phân tích Admin: "chữ nào hay sai nhất" & "hay gõ nhầm chữ nào thành chữ nào".
 */
export function extractCharMistakes(target, typedInput, errorType = 'wrong') {
    const expectedChars = [...String(target || '').trim()];
    const actualChars = [...String(typedInput || '').trim()];
    if (expectedChars.length === 0) return [];

    // Nếu người dùng bấm Xem đáp án / Hết giờ / Bỏ qua mà chưa gõ gì -> ghi nhận toàn bộ ký tự của mã đó là chưa đọc/gõ kịp
    if (actualChars.length === 0) {
        return expectedChars.map((ch) => ({
            expectedChar: ch,
            actualChar: ''
        }));
    }

    const mistakes = [];
    for (let i = 0; i < expectedChars.length; i++) {
        const exp = expectedChars[i];
        const act = actualChars[i] || '';
        if (exp !== act) {
            mistakes.push({
                expectedChar: exp,
                actualChar: act
            });
        }
    }

    // Trường hợp chuỗi trùng đầu nhưng gõ dư ký tự ở cuối -> ghi nhận lỗi trên ký tự cuối của đáp án
    if (mistakes.length === 0 && actualChars.length > expectedChars.length) {
        mistakes.push({
            expectedChar: expectedChars[expectedChars.length - 1],
            actualChar: actualChars[expectedChars.length]
        });
    }

    return mistakes;
}

export function getDayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function getRangeStartTs(range = 'all', now = Date.now()) {
    if (range === 'today') {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }
    if (range === '7d') {
        return now - 7 * 24 * 60 * 60 * 1000;
    }
    if (range === '30d') {
        return now - 30 * 24 * 60 * 60 * 1000;
    }
    return 0;
}
