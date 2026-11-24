/**
 * Template cấu hình cho Maple Captcha Trainer.
 * Copy sang `config.js` và điền thông tin Firebase của bạn nếu muốn đồng bộ Bảng Quản Lý realtime giữa nhiều máy.
 */
export const APP_CONFIG = {
    APP_ID: 'maple-captcha-trainer',

    // Để null nếu chỉ chạy cục bộ (tự lưu bằng localStorage).
    // Nếu muốn đồng bộ realtime cho cả team, điền Firebase Web App config vào đây:
    FIREBASE_CONFIG: null,
    /*
    FIREBASE_CONFIG: {
        apiKey: "YOUR_API_KEY",
        authDomain: "YOUR_PROJECT.firebaseapp.com",
        projectId: "YOUR_PROJECT_ID",
        storageBucket: "YOUR_PROJECT.appspot.com",
        messagingSenderId: "YOUR_SENDER_ID",
        appId: "YOUR_APP_ID"
    },
    */

    // Ngưỡng đánh giá chế độ Thi Test (10 hoặc 20 mã)
    TEST_MODE: {
        defaultCount: 10,
        passAccuracyPct: 90,
        passAvgSec: 10.0
    }
};
