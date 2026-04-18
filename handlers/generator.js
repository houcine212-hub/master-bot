const crypto = require('crypto');
const QRCodeGenerator = require('qrcode');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');

function generateHash(cardId) {
    return crypto.createHmac('sha256', process.env.SECRET_KEY || 'default_secret').update(cardId).digest('hex');
}

function generateCardId() {
    return 'CARD_' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function calculateIdTotal(state) {
    return (state.hp || 0) + (state.atk || 0) + (state.def || 0) + 
           (state.sta || 0) + (state.mag || 0) + (state.spd || 0) + (state.acc || 0);
}

const ID_INTRO_MSG = `
شرح جميع قدرات البطاقة

سيتم إعطاؤك 10000 نقطة، قم بتوزيعها بذكاء على قدراتك. المجموع يجب ألا يتجاوز 10000.

HP الصحة: مقدار الحياة
Attack الهجوم: قوة الضربة
Defense الدفاع: يقلل من الضرر
Stamina التحمل: طاقتك لاستعمال المهارات
Magic السحر: يقوي المهارات السحرية
Speed السرعة: تحدد من يسبق والتفادي
Accuracy الدقة: تحدد اصابة الهدف

العلاقة بين القدرات:
Attack + Accuracy: هجوم قوي بدقة ضعيفة = ضربات تضيع
Defense + HP: دفاع قوي وصحة عالية = يصعب قتلك
Speed vs Accuracy: السرعة تتفادى الدقة، والدقة تغلب السرعة

لبدء التوزيع، أرسل: $start
`;

async function handleGeneratorCommands(bot, msg, pool, generatorState) {
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";
    const photo = msg.photo ? msg.photo[msg.photo.length - 1] : null;

    if (text === "" && !photo) return;

    const MASTER_ADMIN = process.env.MASTER_ADMIN_ID || "6058321388";

    if (text.startsWith('$addGen')) {
        if (chatId !== MASTER_ADMIN) return bot.sendMessage(chatId, "مرفوض.");
        const match = text.match(/\$addGen\s+(\d+)/);
        if (!match) return bot.sendMessage(chatId, "الطريقة: $addGen ID");
        try {
            await pool.execute('INSERT IGNORE INTO generators (telegram_id) VALUES (?)', [match[1]]);
            return bot.sendMessage(chatId, `تم إضافة ${match[1]} بنجاح.`);
        } catch (err) { return bot.sendMessage(chatId, "حدث خطأ."); }
    }

    if (text === '$panel') {
        try {
            let isAuthorized = (chatId === MASTER_ADMIN);
            if (!isAuthorized) {
                const [rows] = await pool.execute('SELECT * FROM generators WHERE telegram_id = ?',[chatId]);
                if (rows.length > 0) isAuthorized = true;
            }
            if (!isAuthorized) return bot.sendMessage(chatId, "مرفوض.");

            generatorState[chatId] = { step: 'select_category' };
            const opts = { reply_markup: { keyboard: [[{ text: "Action" }, { text: "ID" }], [{ text: "Cancel" }]], resize_keyboard: true }};
            return bot.sendMessage(chatId, "لوحة التحكم: ما الذي تريد صناعته؟", opts);
        } catch (err) {}
    }

    if (generatorState[chatId]) {
        const state = generatorState[chatId];

        if (text === 'Cancel' || text === '$cancel') {
            delete generatorState[chatId];
            return bot.sendMessage(chatId, "تم إلغاء العملية.", { reply_markup: { remove_keyboard: true } });
        }

        if (state.step === 'select_category') {
            if (text === "Action") {
                state.category = 'action';
                state.step = 'action_wait_qr';
                return bot.sendMessage(chatId, "أرسل صورة QR لبطاقة التعريف الخاصة باللاعب:", { reply_markup: { remove_keyboard: true } });
            } 
            else if (text === "ID") {
                state.category = 'id';
                state.step = 'id_intro';
                return bot.sendMessage(chatId, ID_INTRO_MSG, { reply_markup: { remove_keyboard: true } });
            }
        }
        else if (state.category === 'id') {
            if (state.step === 'id_intro' && text === '$start') {
                state.step = 'id_name';
                return bot.sendMessage(chatId, "أرسل اسم البطاقة:");
            }
            else if (state.step === 'id_name') {
                state.name = text; state.step = 'id_hp';
                return bot.sendMessage(chatId, "أرسل نقاط HP الصحة:\nالمتبقي 10000");
            }

            const processStatInput = (statName, nextStep, nextPrompt) => {
                let val = parseInt(text);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, "يرجى إدخال رقم صحيح.");
                
                let currentTotal = calculateIdTotal(state) + val;
                if (currentTotal > 10000) {
                    return bot.sendMessage(chatId, `تجاوزت الحد. المتبقي لديك هو ${10000 - calculateIdTotal(state)}`);
                }
                
                state[statName] = val;
                state.step = nextStep;
                if (nextStep === 'id_review') {
                    return bot.sendMessage(chatId, getIdReviewMessage(state));
                }
                let remaining = 10000 - calculateIdTotal(state);
                return bot.sendMessage(chatId, `أرسل نقاط ${nextPrompt}:\nالمتبقي ${remaining}`);
            };

            if (state.step === 'id_hp') return processStatInput('hp', 'id_atk', 'Attack الهجوم');
            else if (state.step === 'id_atk') return processStatInput('atk', 'id_def', 'Defense الدفاع');
            else if (state.step === 'id_def') return processStatInput('def', 'id_sta', 'Stamina التحمل');
            else if (state.step === 'id_sta') return processStatInput('sta', 'id_mag', 'Magic السحر');
            else if (state.step === 'id_mag') return processStatInput('mag', 'id_spd', 'Speed السرعة');
            else if (state.step === 'id_spd') return processStatInput('spd', 'id_acc', 'Accuracy الدقة');
            else if (state.step === 'id_acc') return processStatInput('acc', 'id_review', '');

            else if (state.step === 'id_review') {
                if (text === '$generate') {
                    return generateAndSaveCard(bot, chatId, pool, state, generatorState);
                }
                else if (text.startsWith('$')) {
                    const parts = text.split(' ');
                    const cmd = parts[0].replace('$', '').toLowerCase();
                    const val = parseInt(parts[1]);

                    if (['hp', 'atk', 'def', 'sta', 'mag', 'spd', 'acc'].includes(cmd)) {
                        if (isNaN(val) || val < 0) return bot.sendMessage(chatId, "رقم غير صالح.");
                        let tempTotal = calculateIdTotal(state) - state[cmd] + val;
                        if (tempTotal > 10000) return bot.sendMessage(chatId, `المجموع تجاوز 10000.`);
                        state[cmd] = val;
                        return bot.sendMessage(chatId, getIdReviewMessage(state));
                    }
                }
            }
        }
        else if (state.category === 'action') {
            if (state.step === 'action_wait_qr') {
                if (!photo) return bot.sendMessage(chatId, "يرجى إرسال صورة QR.");
                try {
                    const fileLink = await bot.getFileLink(photo.file_id);
                    const image = await Jimp.read(fileLink);
                    const qr = new QrCode();
                    
                    qr.callback = async (err, value) => {
                        if (err || !value) return bot.sendMessage(chatId, "فشل قراءة الصورة.");
                        try {
                            const data = JSON.parse(value.result);
                            const cardIdFromQR = data.card_id.trim().toUpperCase();
                            
                            if (data.hash !== generateHash(cardIdFromQR)) return bot.sendMessage(chatId, "مزور.");
                            
                            // ✅ إصلاح collation: نجيب البطاقة بالـ id فقط ونتحقق من النوع في JS
                            const [rows] = await pool.execute("SELECT * FROM view_all_cards WHERE id = ?", [cardIdFromQR]);
                            if (rows.length === 0 || rows[0].type !== 'id_card') return bot.sendMessage(chatId, "هذه ليست بطاقة تعريفية.");
                            
                            state.idCard = rows[0];
                            state.step = 'action_confirm_id';
                            
                            let info = `بيانات البطاقة التعريفية:\nالاسم: ${state.idCard.name}\nالهجوم المتبقي: ${state.idCard.atk}\nالدفاع المتبقي: ${state.idCard.def}\nالسحر المتبقي: ${state.idCard.mag}\nالسرعة المتبقية: ${state.idCard.spd}\nالدقة المتبقية: ${state.idCard.acc}\n\nهل تود البدأ؟ اكتب ok`;
                            bot.sendMessage(chatId, info);
                        } catch(e) { console.error("[generator] خطأ في البيانات:", e.message); bot.sendMessage(chatId, "خطأ في البيانات."); }
                    };
                    qr.decode(image.bitmap);
                } catch(e) { bot.sendMessage(chatId, "خطأ في المعالجة."); }
            }
            else if (state.step === 'action_confirm_id' && text === 'ok') {
                state.step = 'action_type';
                const opts = { reply_markup: { keyboard: [[{text:"attack"}, {text:"defense"}, {text:"magic"}], [{text:"Cancel"}]], resize_keyboard: true }};
                return bot.sendMessage(chatId, "اختر نوع البطاقة:", opts);
            }
            else if (state.step === 'action_type' && ['attack', 'defense', 'magic'].includes(text)) {
                state.type = text; 
                state.step = 'action_name';
                return bot.sendMessage(chatId, "أرسل اسم البطاقة:", { reply_markup: { remove_keyboard: true } });
            }
            else if (state.step === 'action_name') { 
                state.name = text; 
                state.step = 'action_main_stat';
                
                let limit = 0;
                let statName = "";
                if (state.type === 'attack') { limit = state.idCard.atk; statName = "الهجوم"; }
                else if (state.type === 'defense') { limit = state.idCard.def; statName = "الدفاع"; }
                else if (state.type === 'magic') { limit = state.idCard.mag; statName = "السحر"; }
                
                state.currentLimit = limit;
                return bot.sendMessage(chatId, `أرسل نقاط ${statName}. أقصى عدد متبقي: ${limit}`);
            }
            else if (state.step === 'action_main_stat') {
                let val = parseInt(text);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, "رقم غير صالح.");
                if (val > state.currentLimit) return bot.sendMessage(chatId, `لا يمكن. أقصى عدد متبقي هو ${state.currentLimit}`);
                
                state.statValue = val;
                state.step = 'action_spd';
                return bot.sendMessage(chatId, `أرسل نقاط السرعة. أقصى عدد متبقي: ${state.idCard.spd}`);
            }
            else if (state.step === 'action_spd') {
                let val = parseInt(text);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, "رقم غير صالح.");
                if (val > state.idCard.spd) return bot.sendMessage(chatId, `لا يمكن. أقصى عدد متبقي هو ${state.idCard.spd}`);
                
                state.spd = val;
                state.step = 'action_acc';
                return bot.sendMessage(chatId, `أرسل نقاط الدقة. أقصى عدد متبقي: ${state.idCard.acc}`);
            }
            else if (state.step === 'action_acc') {
                let val = parseInt(text);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, "رقم غير صالح.");
                if (val > state.idCard.acc) return bot.sendMessage(chatId, `لا يمكن. أقصى عدد متبقي هو ${state.idCard.acc}`);
                
                state.acc = val;

                if (state.type === 'magic') {
                    state.mana = Math.ceil((state.statValue * 0.20) + (state.spd * 0.10) + (state.acc * 0.10));
                    state.stamina = Math.ceil((state.statValue * 0.05) + (state.spd * 0.02));
                } else {
                    state.mana = 0;
                    state.stamina = Math.ceil((state.statValue * 0.15) + (state.spd * 0.05) + (state.acc * 0.05));
                }

                if (state.mana === 0 && state.type === 'magic') state.mana = 5;
                if (state.stamina === 0) state.stamina = 5;

                state.step = 'action_review';
                return bot.sendMessage(chatId, getActionReviewMessage(state));
            }
            else if (state.step === 'action_review') {
                if (text === '$generate') {
                    return generateAndSaveCard(bot, chatId, pool, state, generatorState);
                }
            }
        }

        if (state.step === 'ask_send_to_player') {
            if (text === '$ok') { 
                state.step = 'ask_player_id'; 
                return bot.sendMessage(chatId, "أرسل ID اللاعب:"); 
            }
            if (text === 'Cancel' || text === '$cancel') {
                delete generatorState[chatId];
                return bot.sendMessage(chatId, "تم إلغاء الإرسال.");
            }
        }
        else if (state.step === 'ask_player_id') {
            const [rows] = await pool.execute('SELECT * FROM players WHERE player_id_public = ? OR telegram_id = ?', [text.trim(), text.trim()]);
            if (rows.length === 0) return bot.sendMessage(chatId, "لم يتم العثور على اللاعب.");
            state.targetPlayer = rows[0]; 
            state.step = 'confirm_send';
            return bot.sendMessage(chatId, `تأكيد الإرسال لـ ${state.targetPlayer.name}؟ أرسل $confirm`);
        }
        else if (state.step === 'confirm_send' && text === '$confirm') {
            try {
                // 👉 هذا هو السطر الذي نسيته، وهو أساسي لكي لا يحدث الخطأ!
                const targetId = state.targetPlayer.telegram_id;
                
                // 1. إضافة البطاقة لمحفظة اللاعب
                await pool.execute('INSERT IGNORE INTO player_cards (player_id, card_id) VALUES (?, ?)', [targetId, state.generatedCardId]);
                
                // 2. تحديث طاقة اللاعب إذا كانت البطاقة تعريفية
                if (state.category === 'id') {
                    await pool.execute(
                        `UPDATE players SET hp = ?, atk = ?, def = ?, spd = ?, acc = ?, mag = ?, sta = ? WHERE telegram_id = ?`,[state.hp, state.atk, state.def, state.spd, state.acc, state.mag, state.sta, targetId]
                    );
                }

                // 3. إرسال الصورة للمستلم
                await bot.sendPhoto(targetId, state.generatedQrImage, { caption: `استلمت بطاقة: ${state.name}`});
                bot.sendMessage(chatId, `✅ تم إرسال البطاقة لـ ${state.targetPlayer.name} بنجاح، وتم دمج طاقاتها بجسده!`);
                delete generatorState[chatId];
                
            } catch (dbError) {
                console.error("خطأ أثناء تسليم البطاقة:", dbError.message);
                bot.sendMessage(chatId, "❌ حدث خطأ في قاعدة البيانات ولم يتم تسليم البطاقة. راجع الكونسول!");
            }
        }
    }

    function getIdReviewMessage(state) {
        let total = calculateIdTotal(state);
        return `
    مراجعة بطاقة التعريف:
    الاسم: ${state.name}
    HP: ${state.hp}
    ATK: ${state.atk}
    DEF: ${state.def}
    STA: ${state.sta}
    MAG: ${state.mag}
    SPD: ${state.spd}
    ACC: ${state.acc}
    المجموع: ${total} / 10000

    للتعديل أرسل مثلا: $hp 2000
    لإنشاء البطاقة أرسل: $generate
        `;
    }

    function getActionReviewMessage(state) {
        let statName = state.type === 'attack' ? 'الهجوم' : state.type === 'defense' ? 'الدفاع' : 'السحر';
        return `
    مراجعة بطاقة الأكشن:
    النوع: ${state.type}
    الاسم: ${state.name}
    ${statName}: ${state.statValue}
    السرعة: ${state.spd}
    الدقة: ${state.acc}
    المانا (تلقائي): ${state.mana}
    التحمل (تلقائي): ${state.stamina}

    للإعتماد أرسل: $generate
        `;
    }

    async function generateAndSaveCard(bot, chatId, pool, state, generatorState) {
        try {
            const newCardId = generateCardId();
            
            if (state.category === 'id') {
                await pool.execute(
                    'INSERT INTO cards_id (id, name, hp, atk, def, spd, acc, mag, sta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',[newCardId, state.name, state.hp, state.atk, state.def, state.spd, state.acc, state.mag, state.sta]
                );
            } else {
                if (state.type === 'attack') {
                    await pool.execute('INSERT INTO cards_attack (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',[newCardId, state.name, state.statValue, state.mana, state.stamina, state.spd, state.acc]);
                } 
                else if (state.type === 'defense') {
                    await pool.execute('INSERT INTO cards_defense (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',[newCardId, state.name, state.statValue, state.mana, state.stamina, state.spd, state.acc]);
                } 
                else if (state.type === 'magic') {
                    await pool.execute('INSERT INTO cards_magic (id, name, value, mana_cost, stamina_cost, spd, acc) VALUES (?, ?, ?, ?, ?, ?, ?)',[newCardId, state.name, state.statValue, state.mana, state.stamina, state.spd, state.acc]);
                }

                let atk = state.type === 'attack' ? state.statValue : 0;
                let def = state.type === 'defense' ? state.statValue : 0;
                let mag = state.type === 'magic' ? state.statValue : 0;

                await pool.execute(
                    'UPDATE cards_id SET atk = atk - ?, def = def - ?, mag = mag - ?, spd = spd - ?, acc = acc - ? WHERE id = ?',[atk, def, mag, state.spd, state.acc, state.idCard.id]
                );
            }

            const hash = generateHash(newCardId);
           const qrImage = await QRCodeGenerator.toBuffer(JSON.stringify({ card_id: newCardId, hash: hash }), {
    margin: 4,      // إضافة حافة بيضاء عريضة (Quiet Zone) مهمة جداً للتعرف على الكود
    width: 600,     // تكبير حجم الصورة لتنجو من خوارزميات ضغط تيليجرام
    color: {
        dark: '#000000',  // لون المربعات (أسود داكن)
        light: '#ffffff'  // لون الخلفية (أبيض ناصع للتباين)
    }
});

            state.generatedCardId = newCardId;
            state.generatedQrImage = qrImage;
            state.step = 'ask_send_to_player';

            await bot.sendPhoto(chatId, qrImage, { caption: ` تم الصنع بنجاح\nID: ${newCardId}` });
            return bot.sendMessage(chatId, "هل تريد إرسالها للاعب؟ اكتب $ok أو Cancel");

        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, " فشل حفظ البطاقة في قاعدة البيانات.");
        }
    }
}

module.exports = { handleGeneratorCommands };