const Jimp   = require('jimp');
const jsQR   = require('jsqr');
const crypto = require('crypto');
const { BotAI } = require('./botAI');

// ✅ نظام التطوير التلقائي للبطاقات
const { syncCardScaling, getEffectiveCard, buildSyncMessage } = require('../utils/cardScaling');

function generateHash(cardId) {
    return crypto.createHmac('sha256', process.env.SECRET_KEY || 'default_secret').update(cardId).digest('hex');
}

async function handlePhoto(bot, msg, pool, activeBattles, activePvP) {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const photo  = msg.photo[msg.photo.length - 1];

    try {
        const fileLink  = await bot.getFileLink(photo.file_id);
        const image     = await Jimp.read(fileLink);
        const imageData = new Uint8ClampedArray(image.bitmap.data);
        const code      = jsQR(imageData, image.bitmap.width, image.bitmap.height);

        if (!code || !code.data) {
            return bot.sendMessage(chatId,
                "❌ فشل قراءة الـ QR. يرجى إرسال الصورة كـ 'ملف' (File) لتجنب ضعف الجودة.",
                { reply_to_message_id: msg.message_id }
            );
        }

        try {
            const data         = JSON.parse(code.data);
            const cardIdFromQR = data.card_id.trim().toUpperCase();

            if (data.hash !== generateHash(cardIdFromQR)) {
                return bot.sendMessage(chatId, "⚠️ هذا الـ QR Code مزور أو تالف!", { reply_to_message_id: msg.message_id });
            }

            // التحقق من ملكية اللاعب للبطاقة
            const [ownerRows] = await pool.execute(
                'SELECT * FROM player_cards WHERE player_id = ? AND card_id = ?',
                [userId, cardIdFromQR]
            );
            if (ownerRows.length === 0) {
                return bot.sendMessage(chatId,
                    `🚫 لا تملك البطاقة ${cardIdFromQR} في محفظتك!`,
                    { reply_to_message_id: msg.message_id }
                );
            }

            // جلب بيانات البطاقة الأصلية من قاعدة البيانات
            const [cardInfo] = await pool.execute('SELECT * FROM view_all_cards WHERE id = ?', [cardIdFromQR]);
            if (cardInfo.length === 0) {
                return bot.sendMessage(chatId, "❓ بطاقة غير معرفة في النظام.", { reply_to_message_id: msg.message_id });
            }
            let card = cardInfo[0];

            // ═══════════════════════════════════════════════════════════
            // ✅ نظام التطوير التلقائي
            //
            // إذا كانت بطاقة ID:
            //   → قارن إحصائياتها بآخر لقطة محفوظة
            //   → إذا تغيرت → حدّث جميع بطاقات الأكشن تلقائياً
            //
            // إذا كانت بطاقة أكشن (هجوم/دفاع/سحر):
            //   → استبدل قيمة/سرعة/دقة البطاقة بالإحصائيات الفعلية المطوّرة
            // ═══════════════════════════════════════════════════════════
            if (card.type === 'id_card') {
                // ✅ الإصلاح الجوهري:
                // view_all_cards تحتوي على إحصائيات البطاقة الأساسية (ثابتة).
                // المتجر يحدّث جدول players فقط.
                // لذلك نجلب إحصائيات اللاعب الحالية من players
                // ونطغى بها على بيانات البطاقة حتى يرى syncCardScaling التغييرات.
                const [playerStatRows] = await pool.execute(
                    'SELECT hp, atk, def, mag, spd, acc, sta FROM players WHERE telegram_id = ?',
                    [userId]
                );

                if (playerStatRows.length > 0) {
                    const ps = playerStatRows[0];
                    card = {
                        ...card,
                        hp:  ps.hp  ?? card.hp,
                        atk: ps.atk ?? card.atk,
                        def: ps.def ?? card.def,
                        mag: ps.mag ?? card.mag,
                        spd: ps.spd ?? card.spd,
                        acc: ps.acc ?? card.acc,
                        sta: ps.sta ?? card.sta,
                    };
                }

                // مزامنة التطوير عند مسح بطاقة ID (الآن بالإحصائيات المحدثة)
                const syncResult = await syncCardScaling(pool, userId, {
                    atk: card.atk,
                    def: card.def,
                    mag: card.mag,
                    spd: card.spd,
                    acc: card.acc,
                });

                // إرسال رسالة التطوير إذا كان هناك تغيير
                const syncMsg = buildSyncMessage(syncResult);
                if (syncMsg) {
                    bot.sendMessage(chatId, syncMsg, { parse_mode: 'Markdown' }).catch(() => {});
                }

            } else {
                // استخدام الإحصائيات الفعلية المطوّرة لبطاقات الأكشن
                card = await getEffectiveCard(pool, userId, cardIdFromQR, card);
            }

            // ---------------------------------------------------------
            // ⚔️ نظام نزال اللاعبين (PvP)
            // ---------------------------------------------------------
            if (activePvP && activePvP[chatId]) {
                const { handleBattleQR } = require('./battle');
                return handleBattleQR(bot, msg, pool, activePvP, data);
            }

            // ---------------------------------------------------------
            // 🤖 نظام نزال البوت (PvE)
            // ---------------------------------------------------------
            if (activeBattles && activeBattles[userId]) {
                let battle = activeBattles[userId];

                // === المرحلة 1: استقبال بطاقة الهوية وتهيئة المعركة ===
                if (battle.step === 'wait_id_card') {
                    if (card.type !== 'id_card') {
                        return bot.sendMessage(chatId,
                            "❌ يرجى إرسال بطاقة تعريفية (ID Card) أولاً لبدء النزال!",
                            { reply_to_message_id: msg.message_id }
                        );
                    }

                    const [playerData] = await pool.execute(
                        'SELECT pve_level FROM players WHERE telegram_id = ?', [userId]
                    );
                    const maxPlayerLevel = playerData.length > 0 && playerData[0].pve_level
                        ? playerData[0].pve_level : 1;
                    const playingLevel = battle.selectedLevel ?? maxPlayerLevel;

                    // ✅ الإصلاح: نجيب كل بطاقات البوت ونفلتر في JS لتجنب مشاكل الـ collation
                    const [allBotIdRows] = await pool.execute(
                        "SELECT c.* FROM bot_cards bc JOIN cards_id c ON bc.card_id = c.id WHERE bc.bot_level = ?",
                        [playingLevel]
                    );
                    const botIdRows = allBotIdRows.filter(c => true); // كل سجلات cards_id هي id_card

                    const [allBotCards] = await pool.execute(
                        "SELECT c.* FROM bot_cards bc JOIN view_all_cards c ON bc.card_id = c.id WHERE bc.bot_level = ?",
                        [playingLevel]
                    );
                    const botActionRows = allBotCards.filter(c => c.type !== 'id_card');

                    if (botIdRows.length === 0) {
                        return bot.sendMessage(chatId,
                            `🛠 المستوى ${playingLevel} غير مجهز حالياً.`,
                            { reply_to_message_id: msg.message_id }
                        );
                    }

                    const botIdCard = botIdRows[0];

                    battle.step         = 'battling';
                    battle.turn         = 'player';
                    battle.playingLevel = playingLevel;
                    battle.maxPveLevel  = maxPlayerLevel;

                    battle.player = {
                        name:    card.name,
                        hp:      card.hp,
                        maxHp:   card.hp,
                        atk:     card.atk,
                        def:     card.def,
                        spd:     card.spd,
                        acc:     card.acc,
                        mag:     card.mag,
                        sta:     card.sta,
                        mana:    card.mag,
                        stamina: card.sta,
                        lastCardId: null,
                    };

                    battle.enemy = {
                        name:    `${botIdCard.name} (Lv.${playingLevel})`,
                        hp:      botIdCard.hp,
                        maxHp:   botIdCard.hp,
                        atk:     botIdCard.atk,
                        def:     botIdCard.def,
                        spd:     botIdCard.spd,
                        acc:     botIdCard.acc,
                        mag:     botIdCard.mag,
                        sta:     botIdCard.sta,
                        mana:    botIdCard.mag,
                        stamina: botIdCard.sta,
                        lastCardId: null,
                    };

                    battle.botAI = new BotAI(playingLevel, botActionRows, botIdCard);

                    const aiLabel       = battle.botAI.getDifficultyLabel();
                    const potentialReward = playingLevel * 500;

                    let msgTxt = `📊 **المواجهة المنتظرة**\n`;
                    msgTxt += `🤖 ذكاء البوت: **${aiLabel}**\n\n`;
                    msgTxt += `👤 **أنت (${battle.player.name}):**\n`;
                    msgTxt += `❤️ ${battle.player.hp} | ⚔️ ${battle.player.atk} | 🛡️ ${battle.player.def} | ⚡ ${battle.player.spd} | 🎯 ${battle.player.acc}\n`;
                    msgTxt += `\n🤖 **البوت (${battle.enemy.name}):**\n`;
                    msgTxt += `❤️ ${battle.enemy.hp} | ⚔️ ${battle.enemy.atk} | 🛡️ ${battle.enemy.def} | ⚡ ${battle.enemy.spd} | 🎯 ${battle.enemy.acc}\n`;
                    msgTxt += `\n💰 **مكافأة الفوز:** ${potentialReward} MG\n`;
                    msgTxt += `\n🗡️ **ابدأ! أرسل بطاقة هجوم (دورك للهجوم أولاً).**`;

                    return bot.sendMessage(chatId, msgTxt, {
                        parse_mode: 'Markdown',
                        reply_to_message_id: msg.message_id
                    });
                }

                // === المرحلة 2: دور القتال ===
                // ملاحظة: card هنا تحمل الإحصائيات الفعلية المطوّرة (بعد getEffectiveCard)
                if (battle.step === 'battling') {
                    const player = battle.player;
                    const enemy  = battle.enemy;
                    const ai     = battle.botAI;
                    let battleLog = '';

                    // ── دور اللاعب (يهجم) ──────────────────────────────
                    if (battle.turn === 'player') {
                        if (card.type !== 'attack' && card.type !== 'magic') {
                            return bot.sendMessage(chatId, `❌ دورك للهجوم! أرسل بطاقة هجوم أو سحر.`);
                        }
                        if (player.stamina < card.stamina_cost || player.mana < card.mana_cost) {
                            return bot.sendMessage(chatId, `❌ لا تملك طاقة أو مانا كافية لهذه البطاقة!`);
                        }

                        player.stamina  -= card.stamina_cost;
                        player.mana     -= card.mana_cost;
                        player.lastCardId = card.id;

                        const botCard = ai.chooseCard('defense', {
                            playerAttackCard: card,
                            botHp:      enemy.hp,  botMaxHp:    enemy.maxHp,
                            playerHp:   player.hp, playerMaxHp: player.maxHp,
                            botStamina: enemy.stamina, botMana:  enemy.mana,
                        });

                        if (botCard) {
                            enemy.stamina -= botCard.stamina_cost ?? 0;
                            enemy.mana    -= botCard.mana_cost    ?? 0;
                            enemy.lastCardId = botCard.id;
                        }

                        ai.recordTurn(card, botCard);

                        // ✅ القيم هنا فعلية (بعد التطوير)
                        const pAtkValue = card.value;
                        const pAcc      = card.acc;
                        const bDefValue = botCard ? botCard.value : 0;
                        const bSpd      = botCard ? botCard.spd   : 0;

                        battleLog += `👤 استخدمت: **${card.name}** (💥 ${pAtkValue} | 🎯 ${pAcc})\n`;
                        battleLog += botCard
                            ? `🤖 البوت دافع بـ: **${botCard.name}** (🛡️ ${bDefValue} | 💨 ${bSpd})\n`
                            : `🤖 البوت لم يجد بطاقة دفاع مناسبة!\n`;

                        if (pAcc > bSpd) {
                            enemy.hp -= pAtkValue;
                            battleLog += `\n🎯 **إصابة مباشرة!** دقتك (${pAcc}) تجاوزت سرعته (${bSpd}).\n`;
                            battleLog += `🩸 البوت تلقى **${pAtkValue}** ضرر.\n`;
                        } else {
                            const finalDmg = Math.max(0, pAtkValue - bDefValue);
                            enemy.hp -= finalDmg;
                            battleLog += `\n🛡️ **تصدي!** سرعته (${bSpd}) مكّنه من التخفيف.\n`;
                            battleLog += `📊 الضرر الناتج: **${finalDmg}**.\n`;
                        }

                        // فوز اللاعب + منح MG
                        if (enemy.hp <= 0) {
                            delete activeBattles[userId];
                            const mgReward = battle.playingLevel * 500;
                            try {
                                await pool.execute(
                                    'UPDATE players SET master_gold = master_gold + ? WHERE telegram_id = ?',
                                    [mgReward, userId]
                                );
                                const [balRows] = await pool.execute(
                                    'SELECT master_gold FROM players WHERE telegram_id = ?', [userId]
                                );
                                const newBalance = balRows.length > 0 ? balRows[0].master_gold : '?';

                                let winMsg = battleLog + `\n🏆 **مبروك! هزمت ${enemy.name}!**\n`;
                                winMsg += `💰 **حصلت على ${mgReward} MG** (المستوى ${battle.playingLevel} × 500)\n`;
                                winMsg += `📊 رصيدك الآن: **${newBalance} MG**`;

                                if (battle.playingLevel >= battle.maxPveLevel) {
                                    await pool.execute(
                                        'UPDATE players SET pve_level = pve_level + 1 WHERE telegram_id = ?',
                                        [userId]
                                    );
                                    winMsg += `\n📈 **انتقلت إلى المستوى التالي!**`;
                                }
                                return bot.sendMessage(chatId, winMsg, { parse_mode: 'Markdown' });
                            } catch (dbErr) {
                                console.error('MG reward error (PvE):', dbErr);
                                return bot.sendMessage(chatId,
                                    battleLog + `\n🏆 **مبروك! هزمت ${enemy.name}!**`,
                                    { parse_mode: 'Markdown' }
                                );
                            }
                        }

                        battle.turn = 'bot';
                        battleLog += `\n❤️ **أنت:** ${player.hp} | 🤖 **البوت:** ${enemy.hp}\n`;
                        battleLog += `🔄 **دور البوت للهجوم!** أرسل بطاقة دفاع.`;
                        return bot.sendMessage(chatId, battleLog, {
                            parse_mode: 'Markdown',
                            reply_to_message_id: msg.message_id
                        });
                    }

                    // ── دور البوت (يهجم) / اللاعب يدافع ──────────────
                    else if (battle.turn === 'bot') {
                        if (player.stamina < card.stamina_cost || player.mana < card.mana_cost) {
                            return bot.sendMessage(chatId, `❌ لا تملك طاقة كافية للدفاع!`);
                        }

                        player.stamina  -= card.stamina_cost;
                        player.mana     -= card.mana_cost;
                        player.lastCardId = card.id;

                        const botCard = ai.chooseCard('attack', {
                            playerAttackCard: null,
                            botHp:      enemy.hp,  botMaxHp:    enemy.maxHp,
                            playerHp:   player.hp, playerMaxHp: player.maxHp,
                            botStamina: enemy.stamina, botMana:  enemy.mana,
                        });

                        if (botCard) {
                            enemy.stamina -= botCard.stamina_cost ?? 0;
                            enemy.mana    -= botCard.mana_cost    ?? 0;
                            enemy.lastCardId = botCard.id;
                        }

                        ai.recordTurn(card, botCard);

                        // ✅ القيم هنا فعلية (بعد التطوير)
                        const bAtkValue = botCard ? botCard.value : 0;
                        const bAcc      = botCard ? botCard.acc   : 0;
                        const isDefense = card.type === 'defense';
                        const pDefValue = isDefense ? card.value : 0;
                        const pSpd      = isDefense ? card.spd   : 0;

                        if (botCard) {
                            battleLog += `🤖 البوت هاجم بـ **${botCard.name}** (💥 ${bAtkValue} | 🎯 ${bAcc})\n`;
                        } else {
                            battleLog += `🤖 البوت نفد من طاقته ولم يستطع الهجوم!\n`;
                        }
                        battleLog += `🛡️ أنت دافعت بـ **${card.name}** (🛡️ ${pDefValue} | 💨 ${pSpd})\n`;

                        if (bAcc > pSpd) {
                            player.hp -= bAtkValue;
                            battleLog += `\n⚠️ **فشل التفادي!** دقة البوت (${bAcc}) غلبت سرعتك (${pSpd}).\n`;
                            battleLog += `🩸 تلقيت **${bAtkValue}** ضرر كامل.\n`;
                        } else {
                            const finalDmg = Math.max(0, bAtkValue - pDefValue);
                            player.hp -= finalDmg;
                            battleLog += `\n✅ **دفاع ناجح!** سرعتك (${pSpd}) قلّلت الضرر.\n`;
                            battleLog += `📊 الضرر المتلقى: **${finalDmg}**.\n`;
                        }

                        if (player.hp <= 0) {
                            delete activeBattles[userId];
                            return bot.sendMessage(chatId,
                                battleLog + `\n💀 **خسرت النزال! حاول مجدداً بطاقة أقوى.**`,
                                { parse_mode: 'Markdown' }
                            );
                        }

                        battle.turn = 'player';
                        battleLog += `\n❤️ **أنت:** ${player.hp} | 🤖 **البوت:** ${enemy.hp}\n`;
                        battleLog += `🗡️ **دورك للهجوم الآن!**`;
                        return bot.sendMessage(chatId, battleLog, {
                            parse_mode: 'Markdown',
                            reply_to_message_id: msg.message_id
                        });
                    }
                }
            }

            // ---------------------------------------------------------
            // ℹ️ عرض معلومات البطاقة خارج القتال
            // ---------------------------------------------------------
            const typeMap = { 'attack': 'هجوم', 'defense': 'دفاع', 'magic': 'سحر', 'id_card': 'تعريفية' };
            let info = `📄 **بيانات البطاقة:**\n\n🔹 الاسم: ${card.name}\n🔹 النوع: ${typeMap[card.type] || card.type}\n`;

            if (card.type === 'id_card') {
                info += `❤️ الصحة: ${card.hp}\n⚔️ الهجوم: ${card.atk}\n🛡️ الدفاع: ${card.def}\n`;
                info += `⚡ السرعة: ${card.spd}\n🎯 الدقة: ${card.acc}\n✨ السحر: ${card.mag}\n🔋 التحمل: ${card.sta}`;
            } else {
                info += `💥 القوة: ${card.value} *(فعلية بعد التطوير)*\n`;
                info += `⚡ السرعة: ${card.spd} *(فعلية)*\n🎯 الدقة: ${card.acc} *(فعلية)*\n`;
                info += `💧 مانا: ${card.mana_cost}\n🔋 تحمل: ${card.stamina_cost}`;
            }

            bot.sendMessage(chatId, info, { reply_to_message_id: msg.message_id });

        }  catch (dbError) {
    console.error("=== DATABASE ERROR FULL ===");
    console.error("Message:", dbError.message);
    console.error("SQL:", dbError.sql);
    console.error("Stack:", dbError.stack);
    bot.sendMessage(chatId, "❌ خطأ: " + dbError.message);
}
    } catch (generalError) {
        console.error("Processing Error:", generalError);
        bot.sendMessage(chatId, "❌ حدث خطأ أثناء معالجة الصورة.");
    }
}

module.exports = { handlePhoto };