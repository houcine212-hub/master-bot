const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const crypto = require('crypto');
const QRCodeGenerator = require('qrcode');

// دالة لتوليد الهاش لضمان أمان البطاقة
function generateHash(cardId) {
    return crypto.createHmac('sha256', process.env.SECRET_KEY || 'default_secret').update(cardId).digest('hex');
}

// ✅ الدالة المطلوبة في index.js
async function handleCardCommands(bot, msg, match, pool) {
    const chatId = msg.chat.id.toString();

    const commandUsed = match[0].split(' ')[0].toLowerCase();
    const cardIdParam = match[1].trim().split(' ')[0].toUpperCase();

    try {
        const [rows] = await pool.execute('SELECT * FROM view_all_cards WHERE id = ?', [cardIdParam]);

        if (rows.length === 0) {
            return bot.sendMessage(chatId, "❌ لم يتم العثور على بطاقة بهذا المعرف في النظام.");
        }

        const card = rows[0];
        let info = `🎴 **معلومات البطاقة المستخرجة:**\n\n`;
        info += `🔹 الاسم: ${card.name}\n🔹 النوع: ${card.type}\n`;

        if (card.type === 'id_card') {
            info += `❤️ HP: ${card.hp} | ⚔️ ATK: ${card.atk}\n🛡️ DEF: ${card.def} | ⚡ SPD: ${card.spd}`;
        } else {
            info += `💥 القوة: ${card.value}\n🎯 الدقة: ${card.acc}\n⚡ السرعة: ${card.spd}`;
        }

        if (commandUsed === '$getqr') {
            const hash = generateHash(card.id);

            const qrImage = await QRCodeGenerator.toBuffer(JSON.stringify({ card_id: card.id, hash: hash }), {
                margin: 4,
                width: 600,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });

            return bot.sendPhoto(chatId, qrImage, { caption: info, parse_mode: 'Markdown' });
        }

        else if (commandUsed === '$givecard') {
            return bot.sendMessage(chatId, info + `\n\n⚠️ أمر إعطاء البطاقة يعمل كعرض فقط حالياً، ويحتاج لبرمجة نقلها إلى محفظة اللاعب.`, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error("Card Command Error:", error);
        bot.sendMessage(chatId, "❌ حدث خطأ أثناء جلب بيانات البطاقة.");
    }
}

async function handlePvPLogic(bot, msg, pool, activePvP) {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const text = msg.text ? msg.text.trim() : "";
    
    if (!activePvP[chatId]) return;

    const state = activePvP[chatId];

    if (state.step === 'wait_p1_id') {
        const [rows] = await pool.execute("SELECT * FROM players WHERE player_id_public = ? OR telegram_id = ?", [text, text]);
        if (rows.length === 0) return bot.sendMessage(chatId, " هذا المعرف غير مسجل. أرسل معرفاً صحيحاً للاعب الأول:");

        state.p1_tg = rows[0].telegram_id; 
        state.p1_name = rows[0].name;
        state.step = 'wait_p2_id';
        return bot.sendMessage(chatId, ` تم قبول اللاعب الأول: **${state.p1_name}**\nالآن أرسل ID اللاعب الثاني:`, { parse_mode: 'Markdown' });
    }

    if (state.step === 'wait_p2_id') {
        const [rows] = await pool.execute("SELECT * FROM players WHERE player_id_public = ? OR telegram_id = ?", [text, text]);
        if (rows.length === 0) return bot.sendMessage(chatId, " هذا المعرف غير مسجل. أرسل معرفاً صحيحاً للاعب الثاني:");
        
        if (rows[0].telegram_id === state.p1_tg) {
            return bot.sendMessage(chatId, " لا يمكن للاعب أن يبارز نفسه! أرسل معرف لاعب آخر:");
        }

        state.p2_tg = rows[0].telegram_id;
        state.p2_name = rows[0].name;
        state.step = 'wait_p1_card';
        return bot.sendMessage(chatId, ` تم قبول اللاعب الثاني: **${state.p2_name}**\n\n **مرحلة البطاقات التعريفية**\nيا ${state.p1_name}، أرسل صورة QR لبطاقة تعريفك (ID Card):`, { parse_mode: 'Markdown' });
    }
}

async function handleBattleQR(bot, msg, pool, activePvP, cardData) {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const state = activePvP[chatId];

    if (!state) return;

    if (state.step === 'wait_p1_card' || state.step === 'wait_p2_card') {
        const expectedUser = state.step === 'wait_p1_card' ? state.p1_tg : state.p2_tg;
        if (userId !== expectedUser) return;

        const [rows] = await pool.execute("SELECT * FROM cards WHERE id = ? AND type = 'id_card'", [cardData.card_id]);
        if (rows.length === 0) return bot.sendMessage(chatId, " هذه ليست بطاقة تعريفية! أرسل بطاقة ID Card صحيحة.");

        if (state.step === 'wait_p1_card') {
            state.p1_stats = rows[0];
            state.step = 'wait_p2_card';
            return bot.sendMessage(chatId, ` استلمت بطاقة ${state.p1_name}.\nالآن يا **${state.p2_name}**، أرسل بطاقة تعريفك:`);
        } else {
            state.p2_stats = rows[0];
            return startBattleLoop(bot, chatId, state, pool, activePvP);
        }
    }

    if (state.step === 'wait_turn_actions') {
        if (userId !== state.p1_tg && userId !== state.p2_tg) return;

        const [rows] = await pool.execute("SELECT * FROM cards WHERE id = ?", [cardData.card_id]);
        const card = rows[0];

        if (userId === state.p1_tg && !state.p1_action) {
            state.p1_action = card;
            bot.sendMessage(chatId, ` **${state.p1_name}** جاهز. بانتظار الخصم...`);
        } else if (userId === state.p2_tg && !state.p2_action) {
            state.p2_action = card;
            bot.sendMessage(chatId, ` **${state.p2_name}** جاهز. بانتظار الخصم...`);
        }

        if (state.p1_action && state.p2_action) {
            calculateTurnResult(bot, chatId, state, activePvP, pool);
        }
    }
}

function startBattleLoop(bot, chatId, state, pool, activePvP) {
    state.step = 'wait_turn_actions';
    state.p1_hp = state.p1_stats.hp;
    state.p2_hp = state.p2_stats.hp;

    const table = `
 **بداية النزال !**
-------------------------
 **${state.p1_name}**:  ${state.p1_hp} |  ${state.p1_stats.atk} |  ${state.p1_stats.def}
 **${state.p2_name}**:  ${state.p2_hp} |  ${state.p2_stats.atk} |  ${state.p2_stats.def}
-------------------------
💡 **الفائز يحصل على 50 MG | الخاسر يحصل على 10 MG**
 **الدور الأول:** أرسلوا بطاقات الهجوم الآن!
*(أمامكم 30 ثانية)*
    `;
    
    bot.sendMessage(chatId, table, { parse_mode: 'Markdown' });
    startTimeout(bot, chatId, state, pool, activePvP);
}

// ✅ calculateTurnResult - يستقبل pool الآن لمنح MG
async function calculateTurnResult(bot, chatId, state, activePvP, pool) {
    if (state.timer) clearTimeout(state.timer);
    
    let log = " **نتائج الدور:**\n\n";

    if (state.p1_action.acc > state.p2_stats.spd) {
        let dmg = (state.p1_action.value + state.p1_stats.atk) - state.p2_stats.def;
        dmg = dmg < 10 ? 10 : dmg; 
        state.p2_hp -= dmg;
        log += ` **${state.p1_name}** أصاب بضرر: **${dmg}**\n`;
    } else {
        log += ` **${state.p2_name}** تفادى هجوم ${state.p1_name} بخفة!\n`;
    }

    if (state.p2_action.acc > state.p1_stats.spd) {
        let dmg = (state.p2_action.value + state.p2_stats.atk) - state.p1_stats.def;
        dmg = dmg < 10 ? 10 : dmg;
        state.p1_hp -= dmg;
        log += ` **${state.p2_name}** أصاب بضرر: **${dmg}**\n`;
    } else {
        log += ` **${state.p1_name}** تفادى هجوم ${state.p2_name} بنجاح!\n`;
    }

    state.p1_action = null;
    state.p2_action = null;

    bot.sendMessage(chatId, log, { parse_mode: 'Markdown' });

    // ✅ تحقق من نهاية النزال ومنح MG
    if (state.p1_hp <= 0 || state.p2_hp <= 0) {
        const p1Won    = state.p1_hp > 0;
        const winnerTg = p1Won ? state.p1_tg : state.p2_tg;
        const loserTg  = p1Won ? state.p2_tg : state.p1_tg;
        const winner   = p1Won ? state.p1_name : state.p2_name;
        const loser    = p1Won ? state.p2_name : state.p1_name;

        const WIN_MG  = 50;
        const LOSE_MG = 10;

        let endMsg = `🏆 **انتهى النزال! الفائز هو: ${winner}**\n\n`;

        try {
            // منح MG للفائز
            await pool.execute(
                'UPDATE players SET  master_gold= master_gold + ? WHERE telegram_id = ?',
                [WIN_MG, winnerTg]
            );
            // منح MG للخاسر (مكافأة المشاركة)
            await pool.execute(
                'UPDATE players SET master_gold = master_gold + ? WHERE telegram_id = ?',
                [LOSE_MG, loserTg]
            );

            // جلب أرصدة جديدة
            const [winRows] = await pool.execute('SELECT master_gold FROM players WHERE telegram_id = ?', [winnerTg]);
            const [losRows] = await pool.execute('SELECT master_gold FROM players WHERE telegram_id = ?', [loserTg]);
            const winBal = winRows.length > 0 ? winRows[0].master_gold : '?';
            const losBal = losRows.length > 0 ? losRows[0].master_gold : '?';

            endMsg += `💰 **${winner}** (فائز): +${WIN_MG} MG → رصيده: **${winBal} MG**\n`;
            endMsg += `💔 **${loser}** (خاسر): +${LOSE_MG} MG → رصيده: **${losBal} MG**`;
        } catch (dbErr) {
            console.error('MG reward error (PvP):', dbErr);
            endMsg += `💰 الفائز: +${WIN_MG} MG | الخاسر: +${LOSE_MG} MG`;
        }

        bot.sendMessage(chatId, endMsg, { parse_mode: 'Markdown' });
        delete activePvP[chatId];
    } else {
        bot.sendMessage(chatId, ` **الصحة المتبقية:**\n${state.p1_name}: ${state.p1_hp} | ${state.p2_name}: ${state.p2_hp}\n\nأرسلوا بطاقات الدور التالي...`);
        startTimeout(bot, chatId, state, pool, activePvP);
    }
}

function startTimeout(bot, chatId, state, pool, activePvP) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        if (activePvP[chatId]) {
            bot.sendMessage(chatId, " **انتهى الوقت!** تم إلغاء النزال لعدم استجابة اللاعبين.");
            delete activePvP[chatId];
        }
    }, 30000); 
}

// ✅ تصدير handleCardCommands بالإضافة للدوال الأخرى
module.exports = { handleCardCommands, handlePvPLogic, handleBattleQR };