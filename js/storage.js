/**
 * Module lưu trữ bền vững (localStorage) + đồng bộ Database qua Vercel Serverless API (/api/*).
 * Hỗ trợ Turso (trên Vercel) hoặc SQLite local (qua server.mjs), đồng thời fallback sang localStorage nếu mất mạng.
 */
import { getTodayKey } from './stats.js';

const STORAGE_KEYS = {
    USER_ID: 'mct_user_id_v1',
    PROFILE: 'mct_profile_v2',
    PREFS: 'mct_prefs_v1',
    ADMIN_PIN: 'mct_admin_pin_v1'
};

function safeReadJson(key, fallback = null) {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function safeWriteJson(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Bỏ qua nếu trình duyệt chặn localStorage
    }
}

export const StorageService = (() => {
    let userId = null;
    let dbMode = 'offline'; // 'turso' | 'local' | 'offline'
    let teamRecords = [];
    let onTeamUpdateCb = null;

    function getOrCreateLocalUserId() {
        try {
            let id = window.localStorage.getItem(STORAGE_KEYS.USER_ID);
            if (!id) {
                id = 'u-' + (typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID().slice(0, 10)
                    : Math.random().toString(36).slice(2, 12));
                window.localStorage.setItem(STORAGE_KEYS.USER_ID, id);
            }
            return id;
        } catch {
            return 'u-' + Math.random().toString(36).slice(2, 12);
        }
    }

    function loadLocalProfile() {
        return safeReadJson(STORAGE_KEYS.PROFILE, null);
    }

    function saveLocalProfile(profile) {
        safeWriteJson(STORAGE_KEYS.PROFILE, profile);
    }

    function loadPrefs() {
        return safeReadJson(STORAGE_KEYS.PREFS, {
            soundEnabled: true,
            showKeyboard: true,
            difficulty: 'medium',
            length: '6',
            focusWeakChars: true
        });
    }

    function savePrefs(prefs) {
        safeWriteJson(STORAGE_KEYS.PREFS, prefs);
    }

    function getSavedAdminPin() {
        try { return window.sessionStorage.getItem(STORAGE_KEYS.ADMIN_PIN) || ''; } catch { return ''; }
    }

    function setSavedAdminPin(pin) {
        try {
            if (pin) window.sessionStorage.setItem(STORAGE_KEYS.ADMIN_PIN, pin);
            else window.sessionStorage.removeItem(STORAGE_KEYS.ADMIN_PIN);
        } catch {}
    }

    function mergeProfiles(localProfile, remoteProfile) {
        if (!localProfile) return remoteProfile;
        if (!remoteProfile) return localProfile;
        const preferRemote = (remoteProfile.solved || 0) > (localProfile.solved || 0);
        const today = getTodayKey();
        const dailyStats = { ...(localProfile.dailyStats || {}) };
        if (typeof remoteProfile.todaySolved === 'number') {
            dailyStats[today] = Math.max(dailyStats[today] || 0, remoteProfile.todaySolved);
        }
        return {
            ...localProfile,
            ...(preferRemote ? remoteProfile : {}),
            name: (preferRemote ? remoteProfile.name : localProfile.name) || remoteProfile.name || localProfile.name,
            dailyStats,
            weakChars: localProfile.weakChars || {}
        };
    }

    async function apiFetch(url, options = {}) {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const data = await res.json().catch(() => ({ ok: false }));
        return { status: res.status, data };
    }

    async function init(onTeamUpdate) {
        onTeamUpdateCb = onTeamUpdate;
        const localProfile = loadLocalProfile();
        userId = getOrCreateLocalUserId();

        if (localProfile && localProfile.name) {
            const today = getTodayKey();
            teamRecords = [{
                id: userId,
                userId,
                ...localProfile,
                todaySolved: (localProfile.dailyStats && localProfile.dailyStats[today]) || localProfile.todaySolved || 0
            }];
            if (onTeamUpdateCb) onTeamUpdateCb(teamRecords);
        }

        try {
            const [playerResp, adminResp] = await Promise.all([
                apiFetch(`/api/player?id=${encodeURIComponent(userId)}`),
                apiFetch('/api/admin?range=all', {
                    headers: getSavedAdminPin() ? { 'x-admin-pin': getSavedAdminPin() } : {}
                })
            ]);

            if (playerResp.status === 200 && playerResp.data.ok) {
                dbMode = playerResp.data.dbMode || 'local';
            }

            if (adminResp.status === 200 && adminResp.data.ok && Array.isArray(adminResp.data.teamRecords)) {
                teamRecords = adminResp.data.teamRecords;
                if (onTeamUpdateCb) onTeamUpdateCb(teamRecords);
            }

            const remoteProfile = playerResp.data?.profile || null;
            const merged = mergeProfiles(localProfile, remoteProfile);
            if (merged) saveLocalProfile(merged);

            return { online: dbMode !== 'offline', dbMode, userId, profile: merged };
        } catch {
            dbMode = 'offline';
            return { online: false, dbMode, userId, profile: localProfile };
        }
    }

    function buildLocalRecord(payload) {
        const today = getTodayKey();
        const todaySolved = (payload.dailyStats && payload.dailyStats[today]) || 0;
        return {
            userId,
            name: payload.name,
            solved: payload.solved,
            bestCombo: payload.bestCombo,
            totalTimeMs: payload.totalTimeMs,
            avgTimeSec: payload.solved > 0 ? Number((payload.totalTimeMs / payload.solved / 1000).toFixed(2)) : 0,
            wrongCount: payload.wrongCount || 0,
            revealCount: payload.revealCount || 0,
            timeoutCount: payload.timeoutCount || 0,
            accuracyPct: payload.accuracyPct ?? 100,
            todaySolved,
            todayKey: today,
            bestTestLabel: payload.bestTestLabel || '',
            lastMode: payload.lastMode,
            lastDifficulty: payload.lastDifficulty,
            lastLength: payload.lastLength,
            lastActiveAt: Date.now()
        };
    }

    function updateLocalCache(record, payload) {
        saveLocalProfile({
            ...record,
            dailyStats: payload.dailyStats || {},
            weakChars: payload.weakChars || {}
        });

        const idx = teamRecords.findIndex((r) => r.userId === userId);
        if (idx >= 0) teamRecords[idx] = { id: userId, ...record };
        else teamRecords.push({ id: userId, ...record });
        if (onTeamUpdateCb) onTeamUpdateCb(teamRecords);
    }

    async function savePlayerStats(payload) {
        const record = buildLocalRecord(payload);
        updateLocalCache(record, payload);

        try {
            const resp = await apiFetch('/api/player', {
                method: 'POST',
                body: JSON.stringify(record)
            });
            if (resp.status === 200 && resp.data.ok) {
                dbMode = resp.data.dbMode || dbMode;
            }
        } catch {
            // Đã lưu an toàn ở localStorage
        }
    }

    async function recordAttempt(attemptPayload) {
        const record = buildLocalRecord(attemptPayload);
        updateLocalCache(record, attemptPayload);

        try {
            await apiFetch('/api/attempt', {
                method: 'POST',
                body: JSON.stringify({
                    ...record,
                    mode: attemptPayload.lastMode,
                    difficulty: attemptPayload.lastDifficulty,
                    length: attemptPayload.lastLength,
                    target: attemptPayload.target,
                    typedInput: attemptPayload.typedInput || '',
                    isCorrect: Boolean(attemptPayload.isCorrect),
                    errorType: attemptPayload.errorType || '',
                    elapsedMs: attemptPayload.elapsedMs || 0
                })
            });
        } catch {
            // Bỏ qua lỗi mạng, đã lưu local
        }
    }

    async function recordTestSession(sessionPayload) {
        try {
            await apiFetch('/api/test-session', {
                method: 'POST',
                body: JSON.stringify({
                    userId,
                    ...sessionPayload
                })
            });
        } catch {
            // Bỏ qua lỗi mạng
        }
    }

    async function fetchAdminDashboard({ range = 'all', playerId = '', pin = '' } = {}) {
        const usePin = pin || getSavedAdminPin();
        const params = new URLSearchParams({ range });
        if (playerId) params.set('playerId', playerId);

        try {
            const resp = await apiFetch(`/api/admin?${params.toString()}`, {
                headers: usePin ? { 'x-admin-pin': usePin } : {}
            });
            if (resp.status === 200 && resp.data.ok) {
                dbMode = resp.data.dbMode || dbMode;
                if (Array.isArray(resp.data.teamRecords)) {
                    teamRecords = resp.data.teamRecords;
                    if (onTeamUpdateCb) onTeamUpdateCb(teamRecords);
                }
                if (resp.data.adminUnlocked && pin) {
                    setSavedAdminPin(pin);
                }
                return resp.data;
            }
            return { ok: false, error: resp.data?.error || 'Không thể tải dữ liệu Admin' };
        } catch {
            return {
                ok: true,
                dbMode: 'offline',
                pinRequired: false,
                adminUnlocked: true,
                teamRecords,
                analytics: null,
                playerDetail: null
            };
        }
    }

    async function loginWithNameAndPin(name, pin) {
        try {
            const resp = await apiFetch('/api/player', {
                method: 'POST',
                body: JSON.stringify({ action: 'login', name, pin })
            });
            if (resp.status === 200 && resp.data.ok && resp.data.profile) {
                dbMode = resp.data.dbMode || dbMode;
                const prof = resp.data.profile;
                userId = prof.userId;
                try { window.localStorage.setItem(STORAGE_KEYS.USER_ID, userId); } catch {}
                const today = getTodayKey();
                const dailyStats = {};
                if (prof.todaySolved) dailyStats[today] = prof.todaySolved;
                const fullProfile = { ...prof, dailyStats };
                saveLocalProfile(fullProfile);
                return { ok: true, authMode: resp.data.authMode, profile: fullProfile };
            }
            return { ok: false, code: resp.data?.code, error: resp.data?.error || 'Đăng nhập thất bại.' };
        } catch {
            // Fallback offline nếu không kết nối được API
            userId = getOrCreateLocalUserId();
            const fallbackProfile = {
                userId,
                name,
                solved: 0,
                bestCombo: 0,
                totalTimeMs: 0,
                wrongCount: 0,
                revealCount: 0,
                timeoutCount: 0,
                accuracyPct: 100,
                dailyStats: {},
                weakChars: {},
                bestTestLabel: ''
            };
            saveLocalProfile(fallbackProfile);
            return { ok: true, authMode: 'offline', profile: fallbackProfile };
        }
    }

    function logout() {
        try {
            window.localStorage.removeItem(STORAGE_KEYS.USER_ID);
            window.localStorage.removeItem(STORAGE_KEYS.PROFILE);
        } catch {}
        userId = null;
    }

    async function resetMemberPin(playerId, pin = '') {
        const usePin = pin || getSavedAdminPin();
        const resp = await apiFetch('/api/admin', {
            method: 'PATCH',
            headers: usePin ? { 'x-admin-pin': usePin } : {},
            body: JSON.stringify({ action: 'reset-pin', playerId })
        });
        return resp.data;
    }

    async function resetAdminData({ scope = 'player', playerId = '', pin = '' } = {}) {
        const usePin = pin || getSavedAdminPin();
        const params = new URLSearchParams({ scope });
        if (playerId) params.set('playerId', playerId);

        const resp = await apiFetch(`/api/admin?${params.toString()}`, {
            method: 'DELETE',
            headers: usePin ? { 'x-admin-pin': usePin } : {}
        });
        return resp.data;
    }

    return {
        init,
        loginWithNameAndPin,
        logout,
        savePlayerStats,
        recordAttempt,
        recordTestSession,
        fetchAdminDashboard,
        resetMemberPin,
        resetAdminData,
        loadPrefs,
        savePrefs,
        getTeamRecords() { return teamRecords; },
        getUserId() { return userId; },
        getDbMode() { return dbMode; },
        isOnline() { return dbMode !== 'offline'; }
    };
})();
