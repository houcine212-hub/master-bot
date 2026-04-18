const { generatePlayerId } = require('../utils/helpers');
async function handleRegistration(bot, msg, pool, registrationState) {
    const chatId = msg.chat.id; 
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (text === '$login') {
        const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [userId]);
        if (rows.length > 0) {
            return bot.sendMessage(chatId, `أنت مسجل مسبقاً! الـ ID: ${rows[0].player_id_public}`);
        }
        registrationState[userId] = { step: 1 }; 
        return bot.sendMessage(chatId, "مرحباً! ما هو اسمك؟");
    }

    if (registrationState[userId] && !text.startsWith('$')) {
        const state = registrationState[userId];
        if (state.step === 1) {
            state.name = text;
            state.step = 2;
            return bot.sendMessage(chatId, "اختر اسم شخصيتك:");
        }
        if (state.step === 2) {
            state.character = text;
            const { generatePlayerId } = require('../utils/helpers');
            const newId = generatePlayerId();
            
    
            await pool.execute(
                'INSERT INTO players (player_id_public, telegram_id, name, character_name) VALUES (?, ?, ?, ?)',
                [newId, userId, state.name, state.character]
            );
            delete registrationState[userId];
            return bot.sendMessage(chatId, `تم التسجيل بنجاح! ID الخاص بك: ${newId}`);
        }
    }
}

module.exports = { handleRegistration };