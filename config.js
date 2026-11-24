/**
 * Cấu hình đang chạy của Maple Captcha Trainer.
 * Tham khảo `config.example.js` để bật đồng bộ Firebase Firestore cho team.
 */
export const APP_CONFIG = {
    APP_ID: 'maple-captcha-trainer',
    FIREBASE_CONFIG: null,
    TEST_MODE: {
        defaultCount: 10,
        passAccuracyPct: 90,
        passAvgSec: 10.0
    }
};
