/**
 * ============================================================
 * ملف: utils/activityManager.js
 * الوصف: نظام تتبع النشاط ومنح MG كل 10 دقائق للاعبين النشطين
 * ============================================================
 *
 * آلية العمل:
 *  1. كل رسالة/صورة يرسلها لاعب مسجّل → recordActivity(userId)
 *  2. كل دقيقة يتحقق النظام من كل لاعب نشط
 *  3. إذا كان نشطاً (آخر تفاعل < 10 دقائق) ومرت 10 دقائق على آخر مكافأة → +100 MG
 * ============================================================
 */

const ACTIVITY_REWARD_MG   = 100;            // MG تُمنح كل فترة نشاط
const REWARD_INTERVAL_MS   = 10 * 60 * 1000; // 10 دقائق بين كل مكافأة
const ACTIVITY_TIMEOUT_MS  = 10 * 60 * 1000; // اعتبار اللاعب غير نشط بعد 10 دقائق صمت
const CHECK_INTERVAL_MS    = 60 * 1000;       // الفحص كل دقيقة

/**
 * خريطة حالة النشاط:
 * { userId: { lastActivity: timestamp, lastRewarded: timestamp } }
 */
const activityMap = new Map();

/**
 * تسجيل نشاط اللاعب
 * يُستدعى عند كل رسالة أو صورة يرسلها اللاعب
 * @param {string} userId - معرف تليجرام للاعب
 */
function recordActivity(userId) {
    const now = Date.now();
    if (!activityMap.has(userId)) {
        // أول نشاط: نضبط lastRewarded على الوقت الحالي لنبدأ العدّ من الآن
        activityMap.set(userId, { lastActivity: now, lastRewarded: now });
    } else {
        activityMap.get(userId).lastActivity = now;
    }
}

/**
 * تشغيل حلقة مكافآت النشاط
 * يُستدعى مرة واحدة فقط عند بدء تشغيل البوت
 * @param {Object} pool - اتصال قاعدة البيانات (mysql2/promise pool)
 * @param {Object} bot  - نسخة TelegramBot لإرسال الإشعارات
 */
function startActivityLoop(pool, bot) {
    console.log("✅ نظام مكافآت النشاط تم تشغيله.");

    setInterval(async () => {
        const now = Date.now();

        for (const [userId, data] of activityMap.entries()) {
            try {
                // تحقق: هل اللاعب نشط في آخر 10 دقائق؟
                const isActive = (now - data.lastActivity) < ACTIVITY_TIMEOUT_MS;
                if (!isActive) continue;

                // تحقق: هل مرت 10 دقائق كاملة على آخر مكافأة؟
                const timeSinceReward = now - data.lastRewarded;
                if (timeSinceReward < REWARD_INTERVAL_MS) continue;

                // ✅ منح المكافأة
                data.lastRewarded = now;

                const [result] = await pool.execute(
                    'UPDATE players SET master_gold= master_gold+ ? WHERE telegram_id = ?',
                    [ACTIVITY_REWARD_MG, userId]
                );

                if (result.affectedRows > 0) {
                    // جلب الرصيد الجديد لعرضه
                    const [rows] = await pool.execute(
                        'SELECT master_gold FROM players WHERE telegram_id = ?',
                        [userId]
                    );
                    const newBalance = rows.length > 0 ? rows[0].master_gold : '?';

                    // إشعار اللاعب بالمكافأة
                    bot.sendMessage(
                        userId,
                        `⏱️ **مكافأة النشاط!**\n\n+${ACTIVITY_REWARD_MG} 💰 MG على نشاطك المستمر!\n📊 رصيدك الحالي: **${newBalance} MG**`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => {}); // تجاهل الخطأ إذا لم يستطع البوت الإرسال
                }

            } catch (err) {
                console.error(`[ActivityManager] خطأ للاعب ${userId}:`, err.message);
            }
        }
    }, CHECK_INTERVAL_MS);
}

module.exports = { recordActivity, startActivityLoop };