/**
 * Module tính toán KPI, độ chính xác (Accuracy), Weakness Tracker, chấm điểm Thi Test & xuất CSV.
 * Pure functions để dễ kiểm thử bằng `node --test`.
 */

export function getTodayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function calcAccuracy(solved = 0, wrongCount = 0, revealCount = 0, timeoutCount = 0) {
    const totalAttempts = solved + wrongCount + revealCount + timeoutCount;
    if (totalAttempts <= 0) return 100;
    return Number(((solved / totalAttempts) * 100).toFixed(1));
}

export function recordWeakness(weakChars, target, { isError = false, elapsedMs = 0 } = {}) {
    const next = { ...(weakChars || {}) };
    const chars = [...String(target || '')];
    if (chars.length === 0) return next;
    const perCharMs = Math.max(0, Math.round(elapsedMs / chars.length));

    for (const ch of chars) {
        const prev = next[ch] || { wrong: 0, total: 0, totalMs: 0 };
        next[ch] = {
            wrong: prev.wrong + (isError ? 1 : 0),
            total: prev.total + 1,
            totalMs: prev.totalMs + perCharMs
        };
    }
    return next;
}

/**
 * Xếp hạng các ký tự yếu nhất dựa trên tỉ lệ sai và tốc độ trung bình chậm.
 */
export function getTopWeakChars(weakChars, limit = 5) {
    const entries = Object.entries(weakChars || {})
        .filter(([, v]) => v && v.total > 0)
        .map(([ch, v]) => {
            const errorRate = v.wrong / v.total;
            const avgMs = v.totalMs / v.total;
            // Điểm yếu: ưu tiên chữ từng sai, sau đó tới tốc độ chậm
            const score = v.wrong * 3 + errorRate * 5 + Math.min(avgMs / 2000, 3);
            return { ch, wrong: v.wrong, total: v.total, avgSec: Number((avgMs / 1000).toFixed(2)), score };
        })
        .filter((item) => item.wrong > 0 || item.avgSec >= 2.2)
        .sort((a, b) => b.score - a.score);

    return entries.slice(0, limit);
}

/**
 * Chọn 1 ký tự cho chế độ Tập Phím: nếu có dữ liệu chữ yếu, ưu tiên 60% rơi vào nhóm yếu nhất.
 */
export function pickWeightedChar(weakChars, fallbackPool, rng = Math.random) {
    const topWeak = getTopWeakChars(weakChars, 8);
    if (topWeak.length > 0 && rng() < 0.6) {
        return topWeak[Math.floor(rng() * topWeak.length)].ch;
    }
    return fallbackPool[Math.floor(rng() * fallbackPool.length)];
}

/**
 * Chấm kết quả chế độ Thi Test (10 hoặc 20 mã).
 */
export function evaluateTestResult(session, thresholds = { passAccuracyPct: 90, passAvgSec: 10.0 }) {
    const totalQuestions = session.totalQuestions || 0;
    const passedCount = session.passedCount || 0;
    const failedCount = session.failedCount || 0;
    const totalTimeMs = session.totalTimeMs || 0;
    const accuracyPct = totalQuestions > 0 ? Number(((passedCount / totalQuestions) * 100).toFixed(1)) : 0;
    const avgSec = passedCount > 0 ? Number((totalTimeMs / passedCount / 1000).toFixed(2)) : 0;
    const isPass =
        passedCount > 0 &&
        accuracyPct >= thresholds.passAccuracyPct &&
        avgSec <= thresholds.passAvgSec;

    return {
        totalQuestions,
        passedCount,
        failedCount,
        accuracyPct,
        avgSec,
        totalSec: Number((totalTimeMs / 1000).toFixed(2)),
        isPass,
        label: `${isPass ? 'PASS' : 'FAIL'} (${passedCount}/${totalQuestions} • ${avgSec.toFixed(2)}s)`,
        missedTargets: session.missedTargets || []
    };
}

export function formatTestDiscordReport(playerName, result, thresholds) {
    const statusIcon = result.isPass ? '✅ PASS' : '❌ FAIL';
    const lines = [
        `🎯 KẾT QUẢ THI TEST CAPTCHA — ${playerName}`,
        `• Trạng thái: ${statusIcon} (Chuẩn: >= ${thresholds.passAccuracyPct}% & <= ${thresholds.passAvgSec}s/mã)`,
        `• Đúng: ${result.passedCount}/${result.totalQuestions} (${result.accuracyPct}%)`,
        `• Tốc độ TB: ${result.avgSec > 0 ? `${result.avgSec.toFixed(2)}s/mã` : '--'} | Tổng thời gian: ${result.totalSec.toFixed(1)}s`
    ];
    if (result.missedTargets.length > 0) {
        lines.push(`• Mã sai/bỏ qua: ${result.missedTargets.join(', ')}`);
    }
    return lines.join('\n');
}

function escapeCsvCell(value) {
    const s = String(value ?? '');
    if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/**
 * Xuất danh sách team ra CSV có UTF-8 BOM để mở thẳng bằng Excel không lỗi tiếng Việt.
 */
export function exportTeamCsv(records) {
    const header = ['STT', 'Ten', 'Da giai', 'Hom nay', 'Chinh xac (%)', 'TB (giay/ma)', 'Max Combo', 'Ket qua Test', 'Che do gan nhat', 'Do kho', 'Hoat dong gan nhat'];
    const sorted = [...(records || [])].sort((a, b) => (b.solved || 0) - (a.solved || 0));
    const rows = sorted.map((r, idx) => [
        idx + 1,
        r.name || '',
        r.solved || 0,
        r.todaySolved || 0,
        r.accuracyPct ?? 100,
        r.solved > 0 ? Number(r.avgTimeSec || 0).toFixed(2) : '',
        r.bestCombo || 0,
        r.bestTestLabel || '',
        r.lastMode || '',
        r.lastDifficulty || '',
        r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : ''
    ]);
    const csvLines = [header, ...rows].map((row) => row.map(escapeCsvCell).join(','));
    return '\uFEFF' + csvLines.join('\r\n');
}

/**
 * Phân loại năng lực thành viên & tự động đề xuất hướng bổ túc cụ thể cho Admin.
 * Ngưỡng chuẩn:
 *  - pass (🟢 Đạt chuẩn): solved >= 10, accuracy >= 90%, avgSec <= 10.0s
 *  - urgent (🔴 Cần bổ túc gấp): solved > 0 và (accuracy < 80% hoặc avgSec > 13.0s)
 *  - improve (🟡 Cần cải thiện): các trường hợp còn lại (mới luyện < 10 mã, accuracy 80–89%, hoặc 10.1–13.0s)
 */
export function classifyMemberAndRecommend(member, thresholds = { minSolved: 10, passAcc: 90, urgentAcc: 80, passSec: 10.0, urgentSec: 13.0 }) {
    const solved = Number(member?.solved || 0);
    const acc = Number(member?.accuracyPct ?? 100);
    const avgSec = Number(member?.avgTimeSec || 0);
    const currentLevel = Number(member?.currentLevel || 0);
    const completed = Boolean(member?.completed);
    const weakList = (member?.topWeakChars || []).map((w) => (typeof w === 'string' ? w : w.char)).filter(Boolean).slice(0, 3);
    const weakSuffix = weakList.length > 0 ? ` • Chữ hay sai: ${weakList.join(', ')}` : '';

    // Chế độ đánh giá theo Level (Lv.1 -> Lv.4 -> Hoàn thành)
    if (completed) {
        return {
            tier: 'pass',
            badge: '🏆 Hoàn thành (Lv.4)',
            advice: weakList.length > 0
                ? `Đã vượt qua Thi Test — đạt chuẩn cày game${weakSuffix}`
                : 'Đã vượt qua Thi Test — đạt chuẩn cày game!'
        };
    }

    if (currentLevel >= 1) {
        const levelNames = { 1: 'Lv.1 (1 chữ)', 2: 'Lv.2 (3 chữ)', 3: 'Lv.3 (6 chữ)', 4: 'Lv.4 (Thi Test)' };
        const lvlLabel = levelNames[currentLevel] || `Lv.${currentLevel}`;
        const cls = member?.currentLevelStats;
        const lvlSolved = cls ? Number(cls.solved || 0) : solved;
        const lvlReq = cls ? Number(cls.requiredSolved || 0) : 0;
        const lvlAcc = cls ? Number(cls.accuracyPct ?? 100) : acc;
        const lvlAvgSec = cls ? Number(cls.avgSec || 0) : avgSec;
        const progressText = lvlReq > 0 ? `${lvlSolved}/${lvlReq} mã • ` : '';

        if ((cls ? (lvlSolved + Number(cls.errors || 0)) > 0 : solved > 0) && lvlAcc < thresholds.urgentAcc) {
            return {
                tier: 'urgent',
                badge: `${lvlLabel} • Cần bổ túc`,
                advice: `Chính xác thấp (${lvlAcc}%) ở ${lvlLabel} (${progressText}TB ${lvlAvgSec.toFixed(1)}s) — cần luyện chắc tay trước khi lên cấp${weakSuffix}`
            };
        }
        return {
            tier: 'improve',
            badge: `🔥 ${lvlLabel}`,
            advice: currentLevel === 4
                ? `Đã mở khóa Thi Test — làm bài thi đạt >=90% để hoàn thành${weakSuffix}`
                : `Đang leo ${lvlLabel} (${progressText}Acc ${lvlAcc}%${lvlAvgSec > 0 ? ` • TB ${lvlAvgSec.toFixed(1)}s` : ''}) — hoàn thành mục tiêu để mở Lv.${currentLevel + 1}${weakSuffix}`
        };
    }

    if (solved === 0) {
        return {
            tier: 'improve',
            badge: 'Chưa luyện đủ',
            advice: 'Bắt đầu với Lv.1 (1 chữ) để quen vị trí phím 2-Set.'
        };
    }

    if (acc < thresholds.urgentAcc || avgSec > thresholds.urgentSec) {
        const reasons = [];
        if (acc < thresholds.urgentAcc) reasons.push(`chính xác thấp (${acc}%)`);
        if (avgSec > thresholds.urgentSec) reasons.push(`tốc độ chậm (${avgSec.toFixed(1)}s/mã)`);
        const action = acc < thresholds.urgentAcc
            ? 'Cho tập lại chế độ Tập Phím + bật gợi ý nét'
            : 'Cho luyện Phản Xạ mức Dễ → Chuẩn để đẩy tốc độ';
        return {
            tier: 'urgent',
            badge: 'Cần bổ túc gấp',
            advice: `${action} (${reasons.join(', ')})${weakSuffix}`
        };
    }

    if (solved >= thresholds.minSolved && acc >= thresholds.passAcc && avgSec > 0 && avgSec <= thresholds.passSec) {
        return {
            tier: 'pass',
            badge: 'Đạt chuẩn',
            advice: weakList.length > 0
                ? `Đạt chuẩn cày game — duy trì 15–20 mã/ngày${weakSuffix}`
                : 'Đạt chuẩn cày game — duy trì đều tay bằng Sinh Tồn hoặc Thi Test.'
        };
    }

    if (solved < thresholds.minSolved) {
        return {
            tier: 'improve',
            badge: 'Cần luyện thêm',
            advice: `Mới giải ${solved}/${thresholds.minSolved} mã — cần làm đủ mẫu để đánh giá chính xác${weakSuffix}`
        };
    }

    const focus = acc < thresholds.passAcc
        ? `Cải thiện độ chính xác (${acc}% → >=90%) bằng cách gõ chắc tay`
        : `Đẩy tốc độ (${avgSec.toFixed(1)}s → <=10s/mã) ở chế độ Phản Xạ / Sinh Tồn`;

    return {
        tier: 'improve',
        badge: 'Cần cải thiện',
        advice: `${focus}${weakSuffix}`
    };
}

/**
 * Tạo báo cáo kế hoạch bổ túc ngắn gọn để Admin dán thẳng vào nhóm Discord.
 */
export function formatCoachingDiscordReport(records, analytics = null, today = getTodayKey()) {
    const list = records || [];
    const grouped = { urgent: [], improve: [], pass: [] };
    for (const r of list) {
        const assessment = classifyMemberAndRecommend(r);
        grouped[assessment.tier].push({ ...r, assessment });
    }

    const lines = [
        `📋 KẾ HOẠCH BỔ TÚC CAPTCHA TEAM (${today})`,
        `Tổng quan: 🟢 Đạt chuẩn: ${grouped.pass.length} | 🟡 Cần cải thiện: ${grouped.improve.length} | 🔴 Cần bổ túc gấp: ${grouped.urgent.length}`
    ];

    if (grouped.urgent.length > 0) {
        lines.push('', '🔴 CẦN BỔ TÚC GẤP:');
        grouped.urgent.forEach((m) => {
            lines.push(`• ${m.name} (Acc ${m.accuracyPct ?? 100}% | TB ${m.solved > 0 ? `${Number(m.avgTimeSec).toFixed(1)}s` : '--'}): ${m.assessment.advice}`);
        });
    }

    if (grouped.improve.length > 0) {
        lines.push('', '🟡 CẦN CẢI THIỆN:');
        grouped.improve.forEach((m) => {
            lines.push(`• ${m.name} (Hôm nay ${m.todaySolved || 0} | Acc ${m.accuracyPct ?? 100}% | TB ${m.solved > 0 ? `${Number(m.avgTimeSec).toFixed(1)}s` : '--'}): ${m.assessment.advice}`);
        });
    }

    if (grouped.pass.length > 0) {
        lines.push('', `🟢 ĐẠT CHUẨN (${grouped.pass.length}): ${grouped.pass.map((m) => `${m.name} (${Number(m.avgTimeSec).toFixed(1)}s)`).join(', ')}`);
    }

    if (analytics) {
        const hard = (analytics.topHardChars || []).slice(0, 6).map((c) => `${c.char}(${c.mistakes})`).join(', ');
        const pairs = (analytics.confusionPairs || []).slice(0, 5).map((p) => `${p.expected}→${p.actual}(${p.count})`).join(', ');
        if (hard) lines.push('', `🔥 Chữ cả team hay sai: ${hard}`);
        if (pairs) lines.push(`⚡ Cặp chữ dễ nhầm: ${pairs}`);
    }

    return lines.join('\n');
}
