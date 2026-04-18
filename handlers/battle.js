/**
 * ============================================================
 * ملف: handlers/battle.js
 * الوصف: المحرك الرئيسي للنزالات (PvP & PvE) في لعبة Master Card Game
 * التحديث الأخير: نظام الحسابات المعتمد على بطاقات الأكشن حصراً
 * ============================================================
 */

const crypto = require('crypto');

/**
 * دالة معالجة منطق الـ PvP (لاعب ضد لاعب)
 * تعتمد على تبادل المعرفات ثم الصور
 */
async function handlePvPLogic(bot, msg, pool, activePvP) {
    const chatId = msg.chat.id.toString();
    const text = msg.text ? msg.text.trim() : "";
    const userId = msg.from.id.toString();

    // إذا لم يكن هناك نزال نشط في هذه الدردشة، تجاهل الأمر
    if (!activePvP[chatId]) return;

    const state = activePvP[chatId];

    // المرحلة الأولى: استقبال معرف اللاعب الأول
    if (state.step === 'wait_p1_id') {
        const [rows] = await pool.execute(
            'SELECT * FROM players WHERE player_id_public = ? OR telegram_id = ?',
            [text, text]
        );
        if (rows.length === 0) {
            return bot.sendMessage(chatId, "❌ المعرف غير موجود. أرسل معرفاً صحيحاً للاعب الأول:");
        }

        state.p1_tg = rows[0].telegram_id;
        state.p1_name = rows[0].name;
        state.step = 'wait_p2_id';
        return bot.sendMessage(chatId, `✅ تم قبول اللاعب الأول: **${state.p1_name}**\nالآن أرسل ID اللاعب الثاني:`, { parse_mode: 'Markdown' });
    }

    // المرحلة الثانية: استقبال معرف اللاعب الثاني
    if (state.step === 'wait_p2_id') {
        const [rows] = await pool.execute(
            'SELECT * FROM players WHERE player_id_public = ? OR telegram_id = ?',
            [text, text]
        );
        if (rows.length === 0) {
            return bot.sendMessage(chatId, "❌ المعرف غير موجود. أرسل معرفاً صحيحاً للاعب الثاني:");
        }

        // منع اللاعب من اللعب ضد نفسه في الـ PvP
        if (rows[0].telegram_id === state.p1_tg) {
            return bot.sendMessage(chatId, "🚫 لا يمكنك مبارزة نفسك! اختر خصماً آخر.");
        }

        state.p2_tg = rows[0].telegram_id;
        state.p2_name = rows[0].name;
        state.step = 'wait_p1_card';
        return bot.sendMessage(chatId, `✅ الخصم هو: **${state.p2_name}**\n\n🛡️ **الآن دور ${state.p1_name}:** أرسل صورة بطاقتك التعريفية (ID Card).`, { parse_mode: 'Markdown' });
    }
}

/**
 * دالة إدارة معارك البوت (PvE) - المرحلة القتالية
 * @param {Object} bot - نسخة البوت
 * @param {string} chatId - معرف الدردشة
 * @param {Object} playerAction - بيانات بطاقة الأكشن التي أرسلها اللاعب
 * @param {Object} battleState - حالة المعركة المخزنة في الذاكرة
 */
async function processPvETurn(bot, chatId, playerAction, battleState) {
    try {
        let player = battleState.player;
        let enemy = battleState.enemy;

        // 1. اختيار حركة البوت (الذكاء الاصطناعي البسيط)
        // يبحث البوت عن بطاقة هجوم أو سحر في حقيبته تناسب طاقته الحالية
        let botAction = null;
        if (battleState.turn === 'player') {
            // اللاعب يهاجم، البوت يبحث عن بطاقة دفاع
            const defenses = enemy.deck.filter(c => c.type === 'defense' && enemy.stamina >= c.stamina_cost);
            botAction = defenses.length > 0 ? defenses[Math.floor(Math.random() * defenses.length)] : null;
        } else {
            // البوت يهاجم، يبحث عن بطاقة هجوم أو سحر
            const attacks = enemy.deck.filter(c => (c.type === 'attack' || c.type === 'magic') && enemy.stamina >= c.stamina_cost);
            botAction = attacks.length > 0 ? attacks[Math.floor(Math.random() * attacks.length)] : null;
        }

        let report = "⚔️ **نتيجة الاشتباك:**\n\n";

        // 2. تطبيق خوارزمية الدور (السرعة والدقة تعتمد فقط على بطاقة الأكشن)
        // يتم تجاهل سرعة ودقة بطاقة الـ ID هنا تماماً
        
        if (battleState.turn === 'player') {
            // هجوم اللاعب ضد دفاع البوت
            report += `👤 **أنت** استخدمت: [${playerAction.name}]\n`;
            report += `🤖 **البوت** استخدم: [${botAction ? botAction.name : 'لا يوجد دفاع'}]\n\n`;

            // مقارنة دقة بطاقة اللاعب بسرعة بطاقة البوت (أو سرعة ثابتة إذا لم يدافع)
            let enemySpeed = botAction ? botAction.spd : 100;
            
            if (playerAction.acc > enemySpeed) {
                // إصابة مباشرة: استخدام قيمة بطاقة الأكشن كضرر خام
                let dmg = playerAction.value;
                enemy.hp -= dmg;
                report += `🎯 **ضربة ناجحة!** دقتك (${playerAction.acc}) غلبت سرعته (${enemySpeed}).\n🩸 ضرر: **${dmg}**\n`;
            } else {
                // المدافع أسرع: تقليل الضرر بناءً على قيمة دفاع بطاقة الأكشن
                let defValue = botAction ? botAction.value : 0;
                let finalDmg = playerAction.value - defValue;
                finalDmg = finalDmg < 0 ? 0 : finalDmg;
                enemy.hp -= finalDmg;
                report += `🛡️ **تفادي جزئي!** الخصم كان سريعاً (${enemySpeed}).\n📊 الضرر المتبقي: **${finalDmg}**\n`;
            }

            // تحديث طاقة البوت
            if (botAction) enemy.stamina -= botAction.stamina_cost;
            battleState.turn = 'bot'; // انتقال الدور للبوت

        } else {
            // هجوم البوت ضد دفاع اللاعب
            report += `🤖 **البوت** يهجم بـ: [${botAction ? botAction.name : 'ضربة يدوية'}]\n`;
            report += `👤 **أنت** تدافع بـ: [${playerAction.name}]\n\n`;

            let botAcc = botAction ? botAction.acc : 150;
            let playerSpeed = playerAction.spd;

            if (botAcc > playerSpeed) {
                let dmg = botAction ? botAction.value : 200;
                player.hp -= dmg;
                report += `⚠️ **تلقيت إصابة!** دقة البوت (${botAcc}) تجاوزت سرعتك (${playerSpeed}).\n🩸 الضرر: **${dmg}**\n`;
            } else {
                let playerDef = playerAction.value;
                let finalDmg = (botAction ? botAction.value : 200) - playerDef;
                finalDmg = finalDmg < 0 ? 0 : finalDmg;
                player.hp -= finalDmg;
                report += `✅ **دفاع متقن!** سرعتك (${playerSpeed}) ساعدتك.\n📊 تلقيت فقط: **${finalDmg}** ضرر.\n`;
            }

            if (botAction) enemy.stamina -= botAction.stamina_cost;
            battleState.turn = 'player'; // عودة الدور للاعب
        }

        // 3. التحقق من حالات النهاية (فوز/خسارة)
        if (enemy.hp <= 0) {
            report += `\n🏆 **نهاية المعركة: لقد سحقت البوت بنجاح!**`;
            // تحديث مستوى اللاعب في قاعدة البيانات
            await pool.execute('UPDATE players SET pve_level = pve_level + 1 WHERE telegram_id = ?', [battleState.userId]);
            delete battleState; 
            return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        if (player.hp <= 0) {
            report += `\n💀 **لقد سقطت في المعركة! حاول تحسين استراتيجيتك.**`;
            delete battleState;
            return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        // 4. عرض الحالة المحدثة للاعب
        let status = `\n❤️ **صحتك:** ${player.hp} | 🤖 **البوت:** ${enemy.hp}\n`;
        status += battleState.turn === 'player' ? "🟢 **دورك للهجوم!** أرسل بطاقة هجوم." : "🟡 **البوت يستعد!** أرسل بطاقة دفاع.";
        
        await bot.sendMessage(chatId, report + status, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Battle Logic Error:", error);
        bot.sendMessage(chatId, "❌ حدث خلل فني أثناء حساب الدور. تم إلغاء النزال.");
    }
}

/**
 * دالة مساعدة لحساب الضرر بناءً على القواعد الجديدة
 * @param {number} atkValue - قيمة الهجوم من بطاقة الأكشن
 * @param {number} acc - دقة بطاقة الأكشن
 * @param {number} targetSpd - سرعة بطاقة الخصم
 * @param {number} targetDefValue - قيمة الدفاع من بطاقة الخصم
 */
function calculateRawDamage(atkValue, acc, targetSpd, targetDefValue) {
    // القاعدة الأساسية: إذا كانت الدقة أعلى من السرعة = ضرر كامل
    if (acc > targetSpd) {
        return atkValue;
    } 
    // إذا كانت السرعة أعلى = يتم طرح قيمة الدفاع من الهجوم
    else {
        let result = atkValue - targetDefValue;
        return result > 0 ? result : 0;
    }
}

// تصدير الدوال لاستخدامها في photoHandler.js و index.js
module.exports = {
    handlePvPLogic,
    processPvETurn,
    calculateRawDamage
};

/**
 * نهاية ملف battle.js
 * تم بناء هذا النظام ليكون مرناً وقابلاً للتوسع في المستقبل ليشمل (Buffs) و (Debuffs)
 * مع الحفاظ على فصل كامل بين إحصائيات الهوية الدائمة وإحصائيات المعركة المؤقتة.
 */