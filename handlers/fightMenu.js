function handleFightCommand(bot, msg, activePvP, activeBattles) {
    const chatId = msg.chat.id.toString();
    const text = msg.text ? msg.text.trim() : "";

    if (text === '$fight') {
        const opts = {
            reply_markup: {
                inline_keyboard:[[{ text: " نزال ضد البوت (PvE)", callback_data: "fight_pve" }],[{ text: "⚔️ نزال ضد لاعب (PvP)", callback_data: "fight_pvp" }]
                ]
            }
        };
        return bot.sendMessage(chatId, " **قائمة القتال**\nاختر نوع النزال الذي تريده:", opts);
    }
}

function handleFightCallback(bot, query, activePvP, activeBattles) {
    const chatId = query.message.chat.id.toString();
    const data = query.data;

    if (data === 'fight_pve') {
        activeBattles[chatId] = { step: 'wait_id_card' };
        bot.sendMessage(chatId, " **اخترت قتال البوت!**\n\nللبدء، يرجى إرسال صورة الـ QR لبطاقتك التعريفية (ID Card) لتحميل بياناتك (صحتك ودفاعك).");
        bot.answerCallbackQuery(query.id);
    } else if (data === 'fight_pvp') {
        activePvP[chatId] = { step: 'wait_p1_id' };
        bot.sendMessage(chatId, " **اخترت قتال لاعب ضد لاعب!**\n\nأرسل المعرف (ID) الخاص باللاعب الأول:");
        bot.answerCallbackQuery(query.id);
    }
}

module.exports = { handleFightCommand, handleFightCallback };