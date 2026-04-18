require('dotenv').config();
process.env.NTBA_FIX_350 = 1;

const TelegramBot = require('node-telegram-bot-api');
const pool = require('./config/db');

// استدعاء الملفات (Handlers)
const { handleGeneratorCommands } = require('./handlers/generator');
const { handleRegistration }      = require('./handlers/registration');
const { handlePvPLogic }          = require('./handlers/battle');
const { handleCardCommands }      = require('./handlers/cards');
const { handlePhoto }             = require('./handlers/photoHandler');
const { handleBotCards, handleBotCardsCallback } = require('./handlers/botcards');
const { handleStore, handleStoreCallback, handleStoreEffectTypeCallback } = require('./handlers/store');

// ✅ نظام النشاط ومكافآت MG
const { recordActivity, startActivityLoop } = require('./utils/activityManager');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// State Management
const activeBattles     = {};
const registrationState = {};
const generatorState    = {};
const activePvP         = {};
const botCardsState     = {};
const storeState        = {};

// ✅ تشغيل حلقة مكافآت النشاط (مرة واحدة عند بدء البوت)
startActivityLoop(pool, bot);

// ─────────────────────────────────────────────────────────
// معالجة الصور
// ─────────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();

    // ✅ تسجيل نشاط المستخدم عند إرسال صورة
    try {
        const [playerCheck] = await pool.execute(
            'SELECT telegram_id FROM players WHERE telegram_id = ?', [userId]
        );
        if (playerCheck.length > 0) recordActivity(userId);
    } catch (_) {}

    if (generatorState[chatId]) {
        return handleGeneratorCommands(bot, msg, pool, generatorState);
    }

    handlePhoto(bot, msg, pool, activeBattles, activePvP);
});

// ─────────────────────────────────────────────────────────
// معالجة الأزرار (Callback)
// ─────────────────────────────────────────────────────────
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id.toString();
    const userId = callbackQuery.from.id.toString();
    const data   = callbackQuery.data;

    // ✅ تسجيل نشاط عند الضغط على أزرار
    try {
        const [playerCheck] = await pool.execute(
            'SELECT telegram_id FROM players WHERE telegram_id = ?', [userId]
        );
        if (playerCheck.length > 0) recordActivity(userId);
    } catch (_) {}

    // ✅ أزرار نظام بطاقات البوت
    if (data.startsWith('bc_')) {
        return handleBotCardsCallback(bot, callbackQuery, pool, botCardsState);
    }

    // ✅ أزرار المتجر
    if (data.startsWith('sc_')) {
        return handleStoreCallback(bot, callbackQuery, storeState);
    }
    if (data.startsWith('st_')) {
        return handleStoreEffectTypeCallback(bot, callbackQuery, storeState);
    }

    if (data === 'pvp_friendly') {
        activePvP[chatId] = { step: 'wait_p1_id', type: 'friendly' };
        bot.sendMessage(chatId, "⚔️ **بدء مباراة ودية**\nالرجاء إرسال ID الخاص باللاعب الأول:", { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(callbackQuery.id);
    }
    else if (data === 'pvp_finish') {
        bot.sendMessage(chatId, "⏳ ميزة مباراة التفنيش قيد التطوير حالياً.");
        bot.answerCallbackQuery(callbackQuery.id);
    }
    else if (data === 'pve_bot') {
        try {
            const [rows] = await pool.execute('SELECT name, character_name FROM players WHERE telegram_id = ?', [userId]);
            let registeredName = callbackQuery.from.first_name;
            if (rows.length > 0) registeredName = rows[0].character_name || rows[0].name;

            activeBattles[userId] = { step: 'wait_id_card' };
            const PVE_GROUP_LINK = "https://t.me/+vIQuUcgXOAlhZmE0";

            bot.sendMessage(chatId, `🤖 **مرحباً بك يا [${registeredName}](tg://user?id=${userId})!**\n\nساحة قتال البوت مخصصة في مجموعة خاصة. يرجى الانتقال إلى هناك وإرسال صورة الـ QR لبطاقتك التعريفية (ID Card) لتبدأ المعركة تلقائياً!`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "⚔️ انتقال إلى ساحة القتال", url: PVE_GROUP_LINK }]] }
            });

            const PVE_GROUP_ID = process.env.PVE_GROUP_ID;
            if (PVE_GROUP_ID) {
                bot.sendMessage(PVE_GROUP_ID, `مرحبا [${registeredName}](tg://user?id=${userId})\nابعت صورة لبطاقة id الخاص بك`, { parse_mode: 'Markdown' });
            }
            bot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            console.error("خطأ في جلب بيانات اللاعب:", error);
            bot.sendMessage(chatId, "❌ حدث خطأ أثناء تجهيز النزال.");
        }
    }
});

// ─────────────────────────────────────────────────────────
// معالجة الرسائل النصية
// ─────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    if (!msg.text) return;

    const chatId = msg.chat.id.toString();
    const text   = msg.text.trim();
    const userId = msg.from.id.toString();

    // ✅ تسجيل النشاط لكل لاعب مسجّل يرسل رسالة
    try {
        const [playerCheck] = await pool.execute(
            'SELECT telegram_id FROM players WHERE telegram_id = ?', [userId]
        );
        if (playerCheck.length > 0) recordActivity(userId);
    } catch (_) {}

    // ✅ نظام صناعة بطاقات البوت
    if (text === '$botcards' || botCardsState[chatId]) {
        return handleBotCards(bot, msg, pool, botCardsState);
    }

    // =========================
    // 💰 أمر عرض رصيد MG ($mg)
    // =========================
    if (text === '$mg' || text === '$balance') {
        try {
            const [rows] = await pool.execute(
                'SELECT name, character_name, master_gold, pve_level FROM players WHERE telegram_id = ?',
                [userId]
            );
            if (rows.length === 0) {
                return bot.sendMessage(chatId, "❌ أنت غير مسجّل! استخدم `$login` أولاً.", { parse_mode: 'Markdown' });
            }
            const p = rows[0];
            const displayName = p.character_name || p.name;
            const mgMsg = `💰 **رصيد MG الخاص بك**\n\n`
                + `👤 اللاعب: **${displayName}**\n`
                + `💎 الرصيد: **${p.master_gold} MG**\n`
                + `🎮 مستوى PvE: **${p.pve_level || 1}**\n\n`
                + `📌 **طرق كسب MG:**\n`
                + `⏱️ النشاط: +100 MG / 10 دقيقة\n`
                + `🤖 فوز PvE لفل 1: +500 MG\n`
                + `🤖 فوز PvE لفل N: +N×500 MG\n`
                + `⚔️ فوز مباراة ودية: +50 MG\n`
                + `💔 خسارة مباراة ودية: +10 MG`;

            return bot.sendMessage(chatId, mgMsg, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(err);
            return bot.sendMessage(chatId, "❌ حدث خطأ أثناء جلب رصيدك.");
        }
    }

    // =========================
    // 🎮 أمر اختيار مستوى البوت ($levelX)
    // =========================
    const levelMatch = text.match(/^\$level(\d+)$/i);
    if (levelMatch) {
        const requestedLevel = parseInt(levelMatch[1]);
        try {
            const [rows] = await pool.execute('SELECT pve_level, name, character_name FROM players WHERE telegram_id = ?', [userId]);
            if (rows.length === 0) return bot.sendMessage(chatId, "❌ يجب عليك التسجيل أولاً عبر أمر $login");

            const maxLevel = rows[0].pve_level || 1;
            let registeredName = rows[0].character_name || rows[0].name;

            if (requestedLevel > maxLevel) {
                return bot.sendMessage(chatId, `❌ لا يمكنك لعب المستوى ${requestedLevel} لأنك لم تصله بعد.\n📈 أعلى مستوى وصلت له هو ${maxLevel}.`);
            }

            activeBattles[userId] = { step: 'wait_id_card', selectedLevel: requestedLevel };
            const PVE_GROUP_LINK = "https://t.me/+vIQuUcgXOAlhZmE0";

            // عرض مكافأة المستوى المختار
            const reward = requestedLevel * 500;
            bot.sendMessage(chatId, `🤖 **مرحباً بك يا [${registeredName}](tg://user?id=${userId})!**\n\n✅ لقد اخترت إعادة لعب **المستوى ${requestedLevel}**.\n💰 مكافأة الفوز: **${reward} MG**\nيرجى الانتقال إلى ساحة القتال وإرسال صورة بطاقتك (ID Card)!`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "⚔️ انتقال إلى ساحة القتال", url: PVE_GROUP_LINK }]] }
            });

            const PVE_GROUP_ID = process.env.PVE_GROUP_ID;
            if (PVE_GROUP_ID) {
                bot.sendMessage(PVE_GROUP_ID, `مرحبا[${registeredName}](tg://user?id=${userId})\nاخترت قتال بوت **المستوى ${requestedLevel}**، ابعت صورة بطاقة ID الخاصة بك لتبدأ!`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (err) {
            console.error(err);
        }
        return;
    }

    // =========================
    // 🛑 أمر الإلغاء الشامل ($cancel)
    // =========================
    const cancelKeywords = ['$cancel', 'cancel', 'الغاء', 'إلغاء'];
    if (cancelKeywords.includes(text.toLowerCase())) {
        let canceledAnything = false;

        if (generatorState[chatId])    { delete generatorState[chatId];    canceledAnything = true; }
        if (registrationState[chatId]) { delete registrationState[chatId]; canceledAnything = true; }
        if (activeBattles[chatId])     { delete activeBattles[chatId];     canceledAnything = true; }
        if (botCardsState[chatId])     { delete botCardsState[chatId];     canceledAnything = true; }
        if (storeState[chatId])        { delete storeState[chatId];        canceledAnything = true; }

        for (const [hostId, session] of Object.entries(activePvP)) {
            if (hostId === chatId || session.p1_tg === chatId || session.p2_tg === chatId) {
                const otherPlayer = (session.p1_tg === chatId) ? session.p2_tg : session.p1_tg;
                if (otherPlayer) bot.sendMessage(otherPlayer, "⚠️ **انسحب الخصم!** تم إلغاء النزال.", { parse_mode: 'Markdown' });
                delete activePvP[hostId];
                canceledAnything = true;
            }
        }

        if (canceledAnything) {
            return bot.sendMessage(chatId, "🛑 **تم إلغاء جميع العمليات والنزالات الحالية.**", { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        } else {
            return bot.sendMessage(chatId, "⚠️ أنت لست في أي نزال أو عملية حالياً لإلغائها.", { reply_markup: { remove_keyboard: true } });
        }
    }

    // ✅ نظام المتجر
    if (text === '$store' || text.startsWith('$buy') || text === '$setStore' || storeState[chatId]) {
        return handleStore(bot, msg, pool, storeState);
    }

    // تشغيل الهاندلرز
    handleRegistration(bot, msg, pool, registrationState);
    handleGeneratorCommands(bot, msg, pool, generatorState);

    // PvP logic
    if (activePvP[chatId] && !text.startsWith('$')) {
        handlePvPLogic(bot, msg, pool, activePvP);
    }

    // قائمة القتال
    if (text === '$fight') {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🤝 مباراة ودية",  callback_data: "pvp_friendly" },
                        { text: "💀 مباراة تفنيش", callback_data: "pvp_finish"  }
                    ],
                    [
                        { text: "🤖 نزال مع بوت", callback_data: "pve_bot" },
                        { text: "📜 طور القصة",   url: "https://t.me/+Bo-8ggQ0aEAxMTZk" }
                    ]
                ]
            }
        };
        return bot.sendMessage(chatId, "⚔️ **مرحباً بك في ساحة القتال!**", { parse_mode: 'Markdown', ...opts });
    }

    if (text.startsWith('$getqr') || text.startsWith('$givecard')) {
        const match = text.match(/\$getqr\s+(.+)/) || text.match(/\$givecard\s+(.+)/) || [];
        if (match && match.length > 0) handleCardCommands(bot, msg, match, pool);
        return;
    }

    if (text === '$help' || text === '$commands') {
        const helpMsg = `
**قائمة الأوامر:**

▫️ \`$login\`      — التسجيل
▫️ \`$fight\`      — ساحة القتال
▫️ \`$mg\`         — عرض رصيد MG 💰
▫️ \`$cancel\`     — إلغاء أي عملية
▫️ \`$givecard ID\` — عرض بطاقة
▫️ \`$commands\`   — هذه القائمة

**أوامر الإدارة:**
▫️ \`$store\`      — المتجر
▫️ \`$buy ID\`    — شراء منتج
▫️ \`$botcards\`   — صناعة بطاقات البوت 🆕

**💰 نظام MG:**
▫️ \`$mg\`         — عرض رصيدك الكامل
        `;
        return bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
    }
});

console.log("🤖 Bot is running...");