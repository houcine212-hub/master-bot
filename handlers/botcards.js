/**
 * ============================================================
 * ملف: handlers/botcards.js
 * الوصف: نظام صناعة بطاقات البوت - Master Card Game
 * الأمر: $botcards (مخصص للأدمن فقط)
 * ============================================================
 */

const crypto = require('crypto');
const QRCodeGenerator = require('qrcode');

// ===== دوال مساعدة =====

function generateCardId() {
    return 'CARD_' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateHash(cardId) {
    return crypto.createHmac('sha256', process.env.SECRET_KEY || 'default_secret').update(cardId).digest('hex');
}

/** نقاط التوزيع حسب المستوى: مستوى 1 = 10k، كل مستوى يزيد 5k */
function getBudget(level) {
    return 10000 + (level - 1) * 5000;
}

/** حساب مجموع نقاط بطاقة الـ ID */
function calcIdTotal(s) {
    return (s.hp || 0) + (s.atk || 0) + (s.def || 0) +
           (s.sta || 0) + (s.mag || 0) + (s.spd || 0) + (s.acc || 0);
}

/** توليد QR وإرساله */
async function sendQR(bot, chatId, cardId, caption) {
    const hash = generateHash(cardId);
    const qrImage = await QRCodeGenerator.toBuffer(
        JSON.stringify({ card_id: cardId, hash }),
        { margin: 4, width: 600, color: { dark: '#000000', light: '#ffffff' } }
    );
    await bot.sendPhoto(chatId, qrImage, { caption, parse_mode: 'Markdown' });
    return qrImage;
}

/** رسالة مراجعة بطاقة الـ ID */
function idReviewMsg(s, budget) {
    const total = calcIdTotal(s);
    return `
📋 **مراجعة بطاقة ID البوت:**
━━━━━━━━━━━━━━━━━━
🏷️ الاسم: ${s.name}
❤️ HP: ${s.hp}
⚔️ ATK: ${s.atk}
🛡️ DEF: ${s.def}
💪 STA: ${s.sta}
🔮 MAG: ${s.mag}
⚡ SPD: ${s.spd}
🎯 ACC: ${s.acc}
━━━━━━━━━━━━━━━━━━
📊 المجموع: ${total} / ${budget}
📦 المتبقي: ${budget - total}

✏️ للتعديل: \`$hp 2000\` أو أي صفة أخرى
✅ للإنشاء: \`$generate\`
    `.trim();
}

/** رسالة لوحة التحكم الرئيسية */
function panelMsg(state) {
    const idStats = state.idCardStats;
    const hasId = !!state.idCardId;
    const idInfo = hasId
        ? `\n\n🪪 **بطاقة ID:** تم إنشاؤها ✅\n` +
          `  ⚔️ ATK متبقي: ${idStats.atk} | 🛡️ DEF متبقي: ${idStats.def}\n` +
          `  🔮 MAG متبقي: ${idStats.mag} | ⚡ SPD متبقي: ${idStats.spd} | 🎯 ACC متبقي: ${idStats.acc}`
        : '\n\n⚠️ لم يتم إنشاء بطاقة ID بعد';

    return `
⚙️ **لوحة تحكم بوت المستوى ${state.level}**
💰 نقاط التوزيع: ${getBudget(state.level)}${idInfo}

اختر ما تريد صناعته:
    `.trim();
}

// ===== المعالج الرئيسي =====

async function handleBotCards(bot, msg, pool, botCardsState) {
    const chatId = msg.chat.id.toString();
    const text   = (msg.text || '').trim();

    const MASTER_ADMIN = process.env.MASTER_ADMIN_ID || '6058321388';

    // ─── تشغيل الأمر ───────────────────────────────────────────
    if (text === '$botcards') {
        if (chatId !== MASTER_ADMIN) {
            return bot.sendMessage(chatId, '❌ هذا الأمر مخصص للأدمن فقط.');
        }
        botCardsState[chatId] = { step: 'wait_level' };
        return bot.sendMessage(chatId,
            '🎮 **نظام صناعة بطاقات البوت**\n\nأرسل المستوى المطلوب (مثال: `L1` أو `L2` ...)',
            { parse_mode: 'Markdown' }
        );
    }

    // ─── تجاهل إذا لم يكن هناك جلسة نشطة ──────────────────────
    if (!botCardsState[chatId]) return;

    const state = botCardsState[chatId];

    // ─── إلغاء شامل ─────────────────────────────────────────────
    if (['$cancel', 'cancel', 'إلغاء', 'الغاء'].includes(text.toLowerCase())) {
        delete botCardsState[chatId];
        return bot.sendMessage(chatId, '🛑 تم إلغاء عملية صناعة البطاقات.',
            { reply_markup: { remove_keyboard: true } });
    }

    // ════════════════════════════════════════════════════════════
    // STEP 1: استقبال المستوى
    // ════════════════════════════════════════════════════════════
    if (state.step === 'wait_level') {
        const m = text.match(/^[Ll](\d+)$/);
        if (!m) return bot.sendMessage(chatId, '❌ الصيغة غير صحيحة. مثال: `L1` أو `L3`', { parse_mode: 'Markdown' });

        const level  = parseInt(m[1]);
        const budget = getBudget(level);

        state.level  = level;
        state.budget = budget;
        state.idCardId    = null;
        state.idCardStats = { hp: 0, atk: 0, def: 0, sta: 0, mag: 0, spd: 0, acc: 0 };
        state.step   = 'wait_start';

        return bot.sendMessage(chatId,
            `📊 **المستوى ${level} محدد!**\n💰 نقاط التوزيع: **${budget.toLocaleString()}**\n\nأرسل \`$start\` للبدء.`,
            { parse_mode: 'Markdown' }
        );
    }

    // ════════════════════════════════════════════════════════════
    // STEP 2: $start — عرض لوحة التحكم
    // ════════════════════════════════════════════════════════════
    if (state.step === 'wait_start') {
        if (text !== '$start') return;
        state.step = 'panel';
        return showPanel(bot, chatId, state);
    }

    // ════════════════════════════════════════════════════════════
    // STEP 3: لوحة التحكم — اختيار نوع البطاقة
    // ════════════════════════════════════════════════════════════
    if (state.step === 'panel') {
        return; // نتعامل معها عبر callback فقط
    }

    // ════════════════════════════════════════════════════════════
    // STEP: صناعة بطاقة ID
    // ════════════════════════════════════════════════════════════
    if (state.step === 'id_name') {
        state.currentCard = { name: text, step: 'id_hp' };
        state.step = 'id_hp';
        const rem = state.budget;
        return bot.sendMessage(chatId, `❤️ أرسل نقاط **HP** (الصحة).\n📦 المتبقي: ${rem}`, { parse_mode: 'Markdown' });
    }

    if (['id_hp','id_atk','id_def','id_sta','id_mag','id_spd','id_acc'].includes(state.step)) {
        const statMap = {
            id_hp:  { key: 'hp',  next: 'id_atk', label: 'ATK ⚔️ الهجوم' },
            id_atk: { key: 'atk', next: 'id_def',  label: 'DEF 🛡️ الدفاع' },
            id_def: { key: 'def', next: 'id_sta',  label: 'STA 💪 التحمل' },
            id_sta: { key: 'sta', next: 'id_mag',  label: 'MAG 🔮 السحر' },
            id_mag: { key: 'mag', next: 'id_spd',  label: 'SPD ⚡ السرعة' },
            id_spd: { key: 'spd', next: 'id_acc',  label: 'ACC 🎯 الدقة' },
            id_acc: { key: 'acc', next: 'id_review', label: '' },
        };
        const { key, next, label } = statMap[state.step];
        const val = parseInt(text);
        if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ أدخل رقماً صحيحاً.');

        const currentTotal = calcIdTotal(state.currentCard);
        if (currentTotal + val > state.budget) {
            const rem = state.budget - currentTotal;
            return bot.sendMessage(chatId, `❌ تجاوزت الحد! المتبقي لديك هو **${rem}** فقط.`, { parse_mode: 'Markdown' });
        }

        state.currentCard[key] = val;
        state.step = next;

        if (next === 'id_review') {
            return bot.sendMessage(chatId, idReviewMsg(state.currentCard, state.budget), { parse_mode: 'Markdown' });
        }
        const remaining = state.budget - calcIdTotal(state.currentCard);
        return bot.sendMessage(chatId, `أرسل نقاط **${label}**\n📦 المتبقي: ${remaining}`, { parse_mode: 'Markdown' });
    }

    if (state.step === 'id_review') {
        // تعديل صفة: مثال $hp 2000
        if (text.startsWith('$') && text !== '$generate') {
            const parts = text.split(' ');
            const cmd = parts[0].replace('$', '').toLowerCase();
            const val  = parseInt(parts[1]);
            const validKeys = ['hp','atk','def','sta','mag','spd','acc'];
            if (validKeys.includes(cmd)) {
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ رقم غير صالح.');
                const tempTotal = calcIdTotal(state.currentCard) - (state.currentCard[cmd] || 0) + val;
                if (tempTotal > state.budget) return bot.sendMessage(chatId, `❌ يتجاوز الميزانية (${state.budget}).`);
                state.currentCard[cmd] = val;
                return bot.sendMessage(chatId, idReviewMsg(state.currentCard, state.budget), { parse_mode: 'Markdown' });
            }
        }

        if (text === '$generate') {
            return await saveIdCard(bot, chatId, pool, state, botCardsState);
        }
    }

    // ════════════════════════════════════════════════════════════
    // STEP: صناعة بطاقة Action
    // ════════════════════════════════════════════════════════════
    if (state.step === 'action_name') {
        state.currentCard.name = text;
        state.step = 'action_main_stat';
        const type = state.currentCard.type;
        const idS  = state.idCardStats;
        const limit = type === 'attack' ? idS.atk : type === 'defense' ? idS.def : idS.mag;
        const typeLabel = type === 'attack' ? '⚔️ الهجوم' : type === 'defense' ? '🛡️ الدفاع' : '🔮 السحر';
        state.currentCard.limit = limit;
        return bot.sendMessage(chatId, `أرسل نقاط **${typeLabel}**\n📦 أقصى قيمة: ${limit}`, { parse_mode: 'Markdown' });
    }

    if (state.step === 'action_main_stat') {
        const val = parseInt(text);
        if (isNaN(val) || val <= 0) return bot.sendMessage(chatId, '❌ أدخل رقماً أكبر من صفر.');
        if (val > state.currentCard.limit) {
            return bot.sendMessage(chatId, `❌ لا يمكن. الحد الأقصى هو **${state.currentCard.limit}**`, { parse_mode: 'Markdown' });
        }
        state.currentCard.statValue = val;
        state.step = 'action_spd';
        return bot.sendMessage(chatId, `أرسل نقاط **⚡ السرعة**\n📦 أقصى قيمة: ${state.idCardStats.spd}`, { parse_mode: 'Markdown' });
    }

    if (state.step === 'action_spd') {
        const val = parseInt(text);
        if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ أدخل رقماً صحيحاً.');
        if (val > state.idCardStats.spd) {
            return bot.sendMessage(chatId, `❌ الحد الأقصى للسرعة هو **${state.idCardStats.spd}**`, { parse_mode: 'Markdown' });
        }
        state.currentCard.spd = val;
        state.step = 'action_acc';
        return bot.sendMessage(chatId, `أرسل نقاط **🎯 الدقة**\n📦 أقصى قيمة: ${state.idCardStats.acc}`, { parse_mode: 'Markdown' });
    }

    if (state.step === 'action_acc') {
        const val = parseInt(text);
        if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ أدخل رقماً صحيحاً.');
        if (val > state.idCardStats.acc) {
            return bot.sendMessage(chatId, `❌ الحد الأقصى للدقة هو **${state.idCardStats.acc}**`, { parse_mode: 'Markdown' });
        }
        state.currentCard.acc = val;

        // حساب تكاليف المانا والتحمل تلقائياً
        const sv = state.currentCard.statValue;
        if (state.currentCard.type === 'magic') {
            state.currentCard.mana    = Math.max(5, Math.ceil(sv * 0.20 + val * 0.10 + state.currentCard.spd * 0.10));
            state.currentCard.stamina = Math.max(5, Math.ceil(sv * 0.05 + state.currentCard.spd * 0.02));
        } else {
            state.currentCard.mana    = 0;
            state.currentCard.stamina = Math.max(5, Math.ceil(sv * 0.15 + state.currentCard.spd * 0.05 + val * 0.05));
        }

        state.step = 'action_review';
        return bot.sendMessage(chatId, actionReviewMsg(state.currentCard), { parse_mode: 'Markdown' });
    }

    if (state.step === 'action_review' && text === '$generate') {
        return await saveActionCard(bot, chatId, pool, state, botCardsState);
    }
}

// ════════════════════════════════════════════════════════════
// معالجة الضغط على الأزرار (Callback)
// ════════════════════════════════════════════════════════════
async function handleBotCardsCallback(bot, query, pool, botCardsState) {
    const chatId = query.message.chat.id.toString();
    const data   = query.data;
    bot.answerCallbackQuery(query.id);

    if (!botCardsState[chatId]) return;
    const state = botCardsState[chatId];

    // ─── اختيار نوع البطاقة من لوحة التحكم ───────────────────
    if (data === 'bc_id') {
        if (state.idCardId) {
            return bot.sendMessage(chatId, '⚠️ لقد أنشأت بطاقة ID للبوت مسبقاً في هذه الجلسة.\nأنشئ بطاقات Action بدلاً من ذلك، أو أرسل `$cancel` وابدأ من جديد.', { parse_mode: 'Markdown' });
        }
        state.step = 'id_name';
        state.currentCard = {};
        return bot.sendMessage(chatId, '🏷️ أرسل **اسم بطاقة ID** للبوت:', { parse_mode: 'Markdown' });
    }

    if (data === 'bc_action') {
        if (!state.idCardId) {
            return bot.sendMessage(chatId, '⚠️ يجب إنشاء بطاقة ID أولاً قبل بطاقات الأكشن!');
        }
        state.step = 'select_action_type';
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⚔️ هجومية (Attack)', callback_data: 'bc_type_attack' }],
                    [{ text: '🛡️ دفاعية (Defense)', callback_data: 'bc_type_defense' }],
                    [{ text: '🔮 سحرية (Magic)',    callback_data: 'bc_type_magic' }],
                ]
            }
        };
        return bot.sendMessage(chatId, '🃏 اختر **نوع** بطاقة الأكشن:', { ...opts, parse_mode: 'Markdown' });
    }

    if (['bc_type_attack', 'bc_type_defense', 'bc_type_magic'].includes(data)) {
        const typeMap = { bc_type_attack: 'attack', bc_type_defense: 'defense', bc_type_magic: 'magic' };
        state.currentCard = { type: typeMap[data] };
        state.step = 'action_name';

        const idS  = state.idCardStats;
        const type = state.currentCard.type;
        const mainLimit = type === 'attack' ? idS.atk : type === 'defense' ? idS.def : idS.mag;

        if (mainLimit <= 0) {
            return bot.sendMessage(chatId, `❌ نقاط ${type === 'attack' ? 'الهجوم' : type === 'defense' ? 'الدفاع' : 'السحر'} في بطاقة ID استُنفدت كلياً!`);
        }

        return bot.sendMessage(chatId, '🏷️ أرسل **اسم البطاقة**:', { parse_mode: 'Markdown' });
    }

    if (data === 'bc_done') {
        delete botCardsState[chatId];
        return bot.sendMessage(chatId,
            `✅ **انتهت جلسة صناعة بطاقات بوت المستوى ${state.level}.**\nيمكنك بدء جلسة جديدة بـ \`$botcards\``,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
    }
}

// ════════════════════════════════════════════════════════════
// دوال الحفظ في قاعدة البيانات
// ════════════════════════════════════════════════════════════

async function saveIdCard(bot, chatId, pool, state, botCardsState) {
    try {
        const c   = state.currentCard;
        const cid = generateCardId();

        // حفظ في جدول البطاقات التعريفية
        await pool.execute(
            'INSERT INTO cards_id (id, name, hp, atk, def, spd, acc, mag, sta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [cid, c.name, c.hp || 0, c.atk || 0, c.def || 0, c.spd || 0, c.acc || 0, c.mag || 0, c.sta || 0]
        );

        // ربط البطاقة بمستوى البوت في جدول bot_cards
        await pool.execute(
            'DELETE FROM bot_cards WHERE bot_level = ? AND card_type = ?',
            [state.level, 'id_card']
        );
        await pool.execute(
            'INSERT INTO bot_cards (bot_level, card_id, card_type) VALUES (?, ?, ?)',
            [state.level, cid, 'id_card']
        );

        // تخزين إحصائيات الـ ID في الحالة لتقييد بطاقات الأكشن لاحقاً
        state.idCardId    = cid;
        state.idCardStats = { hp: c.hp, atk: c.atk, def: c.def, sta: c.sta, mag: c.mag, spd: c.spd, acc: c.acc };
        state.step = 'panel';

        await sendQR(bot, chatId, cid,
            `✅ *بطاقة ID البوت تم إنشاؤها*\n🆔 المعرف: \`${cid}\`\nالمستوى: ${state.level}`
        );

        return showPanel(bot, chatId, state);
    } catch (err) {
        console.error('BotCards saveIdCard Error:', err);
        bot.sendMessage(chatId, '❌ حدث خطأ أثناء حفظ بطاقة ID.');
    }
}

async function saveActionCard(bot, chatId, pool, state, botCardsState) {
    try {
        const c    = state.currentCard;
        const type = c.type;
        const cid  = generateCardId();

        // حفظ في الجدول المناسب
        if (type === 'attack') {
            await pool.execute(
                'INSERT INTO cards_attack (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [cid, c.name, c.statValue, c.mana, c.stamina, c.spd, c.acc]
            );
        } else if (type === 'defense') {
            await pool.execute(
                'INSERT INTO cards_defense (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [cid, c.name, c.statValue, c.mana, c.stamina, c.spd, c.acc]
            );
        } else {
            await pool.execute(
                'INSERT INTO cards_magic (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [cid, c.name, c.statValue, c.mana, c.stamina, c.spd, c.acc]
            );
        }

        // ربط البطاقة بمستوى البوت
        await pool.execute(
            'INSERT INTO bot_cards (bot_level, card_id, card_type) VALUES (?, ?, ?)',
            [state.level, cid, type]
        );

        // خصم النقاط المُستخدمة من إحصائيات بطاقة الـ ID (في الذاكرة فقط)
        if (type === 'attack')  state.idCardStats.atk -= c.statValue;
        if (type === 'defense') state.idCardStats.def -= c.statValue;
        if (type === 'magic')   state.idCardStats.mag -= c.statValue;
        state.idCardStats.spd -= c.spd;
        state.idCardStats.acc -= c.acc;

        // تصحيح: لا تسمح بقيم سالبة
        for (const k of ['atk','def','mag','spd','acc']) {
            if (state.idCardStats[k] < 0) state.idCardStats[k] = 0;
        }

        state.step = 'panel';

        const typeLabel = type === 'attack' ? '⚔️ هجومية' : type === 'defense' ? '🛡️ دفاعية' : '🔮 سحرية';
        await sendQR(bot, chatId, cid,
            `✅ *بطاقة أكشن (${typeLabel}) تم إنشاؤها*\n🆔 المعرف: \`${cid}\`\nالمستوى: ${state.level}`
        );

        return showPanel(bot, chatId, state);
    } catch (err) {
        console.error('BotCards saveActionCard Error:', err);
        bot.sendMessage(chatId, '❌ حدث خطأ أثناء حفظ بطاقة الأكشن.');
    }
}

// ════════════════════════════════════════════════════════════
// عرض لوحة التحكم
// ════════════════════════════════════════════════════════════
function showPanel(bot, chatId, state) {
    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🪪 بطاقة ID',      callback_data: 'bc_id'     },
                    { text: '🃏 بطاقة Action', callback_data: 'bc_action' },
                ],
                [
                    { text: '✅ إنهاء الجلسة', callback_data: 'bc_done' }
                ]
            ]
        }
    };
    return bot.sendMessage(chatId, panelMsg(state), opts);
}

// ════════════════════════════════════════════════════════════
// رسالة مراجعة بطاقة Action
// ════════════════════════════════════════════════════════════
function actionReviewMsg(c) {
    const typeLabel = c.type === 'attack' ? '⚔️ هجومية' : c.type === 'defense' ? '🛡️ دفاعية' : '🔮 سحرية';
    return `
📋 **مراجعة بطاقة الأكشن:**
━━━━━━━━━━━━━━━━━━
🏷️ الاسم: ${c.name}
🃏 النوع: ${typeLabel}
💥 القوة: ${c.statValue}
⚡ السرعة: ${c.spd}
🎯 الدقة: ${c.acc}
🔵 المانا (تلقائي): ${c.mana}
💛 التحمل (تلقائي): ${c.stamina}
━━━━━━━━━━━━━━━━━━

✅ للإنشاء: \`$generate\`
    `.trim();
}

module.exports = { handleBotCards, handleBotCardsCallback };