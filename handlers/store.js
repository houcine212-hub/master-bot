/**
 * ============================================================
 * ملف: handlers/store.js
 * الوصف: نظام المتجر الكامل - Master Card Game
 * الأوامر: $store | $buy ID | $setStore (أدمن)
 * ============================================================
 */

// ===== دوال مساعدة =====

/** تحويل اسم الصنف إلى نص عربي مع إيموجي */
function categoryLabel(cat) {
    const map = {
        xp_boost: '⭐ رفع المستوى',
        health:   '❤️ صحة',
        attack:   '⚔️ هجوم',
        defense:  '🛡️ دفاع',
        magic:    '🔮 سحر',
    };
    return map[cat] || cat;
}

/** تحويل نوع التأثير إلى نص */
function effectLabel(type, value, category) {
    if (category === 'xp_boost') return `+${value} مستوى`;
    return type === 'percent' ? `+${value}%` : `+${value}`;
}

/** بناء جدول المتجر نصياً */
function buildStoreTable(products) {
    if (products.length === 0) return '🛒 المتجر فارغ حالياً.';

    let msg = '🏪 **متجر Master**\n';
    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    for (const p of products) {
        msg += `\n🔹 **[${p.id}] ${p.name}**\n`;
        msg += `   📝 ${p.description}\n`;
        msg += `   🏷️ الصنف: ${categoryLabel(p.category)}\n`;
        msg += `   💥 التأثير: ${effectLabel(p.effect_type, p.effect_value, p.category)}\n`;
        msg += `   💰 السعر: **${p.price} MG**\n`;
        msg += `   ⏳ ينتهي: ${p.expiry_date ? new Date(p.expiry_date).toLocaleDateString('ar-MA') : 'بلا انتهاء'}\n`;
    }

    msg += '\n━━━━━━━━━━━━━━━━━━━━━━━━━';
    msg += '\n🛍️ للشراء اكتب: `$buy [ID]`';
    return msg;
}

/** رسالة المراجعة قبل الحفظ */
function reviewMsg(s) {
    return `
📋 **مراجعة المنتج الجديد:**
━━━━━━━━━━━━━━━━━━
🏷️ الاسم: ${s.name}
📝 الوصف: ${s.description}
💰 السعر: ${s.price} MG
⏳ الانتهاء: ${s.expiry || 'بلا انتهاء'}
🧩 الصنف: ${categoryLabel(s.category)}
💥 التأثير: ${effectLabel(s.effect_type, s.effect_value, s.category)}
━━━━━━━━━━━━━━━━━━

✅ للحفظ: \`$confirm\`
❌ للإلغاء: \`$cancel\`
    `.trim();
}

// ════════════════════════════════════════════════════════════
// المعالج الرئيسي
// ════════════════════════════════════════════════════════════
async function handleStore(bot, msg, pool, storeState) {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const text   = (msg.text || '').trim();

    const MASTER_ADMIN = process.env.MASTER_ADMIN_ID || '6058321388';

    // ─── $store : عرض المنتجات ───────────────────────────────
    if (text === '$store') {
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM store
                 WHERE (expiry_date IS NULL OR expiry_date >= CURDATE())
                 ORDER BY id ASC`
            );
            return bot.sendMessage(chatId, buildStoreTable(rows), { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Store fetch error:', err);
            return bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب المتجر.');
        }
    }

    // ─── $buy : شراء منتج بالـ ID أو الاسم ──────────────────
    if (text.startsWith('$buy')) {
        const query = text.replace(/^\$buy\s*/i, '').trim();
        if (!query) return bot.sendMessage(chatId, '❌ الصيغة الصحيحة:\n`$buy 1` أو `$buy Health Potion`', { parse_mode: 'Markdown' });

        try {
            // 1. جلب المنتج — بحث بالـ ID أو الاسم
            const byId = !isNaN(parseInt(query));
            const [pRows] = await pool.execute(
                `SELECT * FROM store
                 WHERE (expiry_date IS NULL OR expiry_date >= CURDATE())
                   AND (${byId ? 'id = ?' : 'LOWER(name) = LOWER(?)'})`,
                [byId ? parseInt(query) : query]
            );
            if (pRows.length === 0)
                return bot.sendMessage(chatId, '❌ المنتج غير موجود أو انتهت صلاحيته.');

            const product = pRows[0];

            // 2. جلب بيانات اللاعب
            const [plRows] = await pool.execute(
                `SELECT * FROM players WHERE telegram_id = ?`, [userId]
            );
            if (plRows.length === 0)
                return bot.sendMessage(chatId, '❌ يجب التسجيل أولاً عبر `$login`', { parse_mode: 'Markdown' });

            const player = plRows[0];

            // 3. التحقق من الرصيد
            if ((player.master_gold || 0) < product.price)
                return bot.sendMessage(chatId,
                    `❌ رصيدك غير كافٍ!\n💰 رصيدك: **${player.master_gold || 0} MG**\n🏷️ السعر: **${product.price} MG**`,
                    { parse_mode: 'Markdown' }
                );

            // 4. تطبيق التأثير وخصم الثمن
            await applyEffect(pool, player, product);

            // 5. خصم MG
            await pool.execute(
                `UPDATE players SET master_gold = master_gold - ? WHERE telegram_id = ?`,
                [product.price, userId]
            );

            // 6. تسجيل عملية الشراء
            await pool.execute(
                `INSERT INTO store_purchases (player_telegram_id, product_id, price_paid) VALUES (?, ?, ?)`,
                [userId, product.id, product.price]
            );

            const remaining = (player.master_gold || 0) - product.price;
            return bot.sendMessage(chatId,
                `✅ **تم الشراء بنجاح!**\n\n` +
                `🛍️ المنتج: **${product.name}**\n` +
                `💥 التأثير: ${effectLabel(product.effect_type, product.effect_value, product.category)}\n` +
                `💰 الرصيد المتبقي: **${remaining} MG**`,
                { parse_mode: 'Markdown' }
            );

        } catch (err) {
            console.error('Buy error:', err);
            return bot.sendMessage(chatId, '❌ حدث خطأ أثناء عملية الشراء.');
        }
    }

    // ─── $setStore : إضافة منتج (أدمن فقط) ──────────────────
    if (text === '$setStore') {
        if (chatId !== MASTER_ADMIN) return bot.sendMessage(chatId, '❌ هذا الأمر للأدمن فقط.');
        storeState[chatId] = { step: 'name' };
        return bot.sendMessage(chatId,
            '🛒 **إضافة منتج جديد**\n\nأرسل **اسم المنتج:**',
            { parse_mode: 'Markdown' }
        );
    }

    // ─── جلسة $setStore النشطة ────────────────────────────────
    if (!storeState[chatId]) return;

    if (['$cancel', 'cancel', 'إلغاء', 'الغاء'].includes(text.toLowerCase())) {
        delete storeState[chatId];
        return bot.sendMessage(chatId, '🛑 تم إلغاء إضافة المنتج.', { reply_markup: { remove_keyboard: true } });
    }

    const state = storeState[chatId];

    // خطوة: الاسم
    if (state.step === 'name') {
        if (!text || text.startsWith('$')) return bot.sendMessage(chatId, '❌ أرسل اسماً صالحاً.');
        state.name = text;
        state.step = 'price';
        return bot.sendMessage(chatId, '💰 أرسل **السعر** (بالـ MG):', { parse_mode: 'Markdown' });
    }

    // خطوة: السعر
    if (state.step === 'price') {
        const val = parseInt(text);
        if (isNaN(val) || val <= 0) return bot.sendMessage(chatId, '❌ أرسل رقماً صحيحاً أكبر من 0.');
        state.price = val;
        state.step = 'expiry';
        return bot.sendMessage(chatId, '⏳ أرسل **تاريخ الانتهاء** (YYYY-MM-DD)\nأو أرسل `none` إذا لا يوجد انتهاء:', { parse_mode: 'Markdown' });
    }

    // خطوة: تاريخ الانتهاء
    if (state.step === 'expiry') {
        if (text.toLowerCase() === 'none') {
            state.expiry = null;
        } else {
            const dateReg = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateReg.test(text)) return bot.sendMessage(chatId, '❌ الصيغة الصحيحة: `2026-05-01` أو `none`', { parse_mode: 'Markdown' });
            state.expiry = text;
        }
        state.step = 'description';
        return bot.sendMessage(chatId, '📝 أرسل **الوصف:**', { parse_mode: 'Markdown' });
    }

    // خطوة: الوصف
    if (state.step === 'description') {
        state.description = text;
        state.step = 'category';
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⭐ رفع المستوى (XP Boost)', callback_data: 'sc_xp_boost' }],
                    [
                        { text: '❤️ صحة',  callback_data: 'sc_health'  },
                        { text: '⚔️ هجوم', callback_data: 'sc_attack'  },
                    ],
                    [
                        { text: '🛡️ دفاع',  callback_data: 'sc_defense' },
                        { text: '🔮 سحر',  callback_data: 'sc_magic'   },
                    ],
                ]
            }
        };
        return bot.sendMessage(chatId, '🧩 اختر **صنف المنتج:**', { ...opts, parse_mode: 'Markdown' });
    }

    // خطوة: قيمة التأثير (بعد اختيار الصنف عبر callback)
    if (state.step === 'effect_value') {
        const val = parseFloat(text);
        if (isNaN(val) || val <= 0) return bot.sendMessage(chatId, '❌ أرسل رقماً أكبر من 0.');
        state.effect_value = val;
        state.step = 'review';
        return bot.sendMessage(chatId, reviewMsg(state), { parse_mode: 'Markdown' });
    }

    // خطوة: تأكيد الحفظ
    if (state.step === 'review' && text === '$confirm') {
        try {
            await pool.execute(
                `INSERT INTO store (name, description, price, expiry_date, category, effect_value, effect_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [state.name, state.description, state.price, state.expiry || null,
                 state.category, state.effect_value, state.effect_type]
            );
            delete storeState[chatId];
            return bot.sendMessage(chatId,
                `✅ **تم إضافة المنتج "${state.name}" بنجاح!**`,
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
            );
        } catch (err) {
            console.error('Store insert error:', err);
            return bot.sendMessage(chatId, '❌ حدث خطأ أثناء الحفظ.');
        }
    }
}

// ════════════════════════════════════════════════════════════
// معالجة أزرار اختيار الصنف
// ════════════════════════════════════════════════════════════
async function handleStoreCallback(bot, query, storeState) {
    const chatId = query.message.chat.id.toString();
    const data   = query.data;
    bot.answerCallbackQuery(query.id);

    if (!storeState[chatId] || storeState[chatId].step !== 'category') return;
    if (!data.startsWith('sc_')) return;

    const state = storeState[chatId];
    const catMap = {
        sc_xp_boost: 'xp_boost',
        sc_health:   'health',
        sc_attack:   'attack',
        sc_defense:  'defense',
        sc_magic:    'magic',
    };

    state.category = catMap[data];

    // XP Boost: نوع التأثير ثابت (flat = عدد المستويات)
    if (state.category === 'xp_boost') {
        state.effect_type = 'flat';
        state.step = 'effect_value';
        return bot.sendMessage(chatId,
            '⭐ كم **مستوى** يرفع هذا المنتج؟ (مثال: `1` أو `2`)',
            { parse_mode: 'Markdown' }
        );
    }

    // بقية الأصناف: يختار الأدمن نوع التأثير أولاً
    state.step = 'effect_type';
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔢 قيمة ثابتة (مثال: +200 HP)', callback_data: 'st_flat'    }],
                [{ text: '📊 نسبة مئوية (مثال: +10%)',     callback_data: 'st_percent' }],
            ]
        }
    };
    return bot.sendMessage(chatId, '❓ نوع التأثير:', { ...opts, parse_mode: 'Markdown' });
}

async function handleStoreEffectTypeCallback(bot, query, storeState) {
    const chatId = query.message.chat.id.toString();
    const data   = query.data;
    bot.answerCallbackQuery(query.id);

    if (!storeState[chatId] || storeState[chatId].step !== 'effect_type') return;
    if (!data.startsWith('st_')) return;

    const state = storeState[chatId];
    state.effect_type = data === 'st_flat' ? 'flat' : 'percent';
    state.step = 'effect_value';

    const catName = categoryLabel(state.category).replace(/^[^ ]+ /, '');
    const hint    = state.effect_type === 'flat'
        ? `كم وحدة تزيد من **${catName}**؟ (مثال: \`200\`)`
        : `بكم نسبة تزيد **${catName}**؟ (مثال: \`10\` تعني 10%)`;

    return bot.sendMessage(chatId, `💥 ${hint}`, { parse_mode: 'Markdown' });
}

// ════════════════════════════════════════════════════════════
// دالة تطبيق التأثير على اللاعب
// ════════════════════════════════════════════════════════════
async function applyEffect(pool, player, product) {
    const tid = player.telegram_id;
    const v   = parseFloat(product.effect_value);

    switch (product.category) {

        case 'xp_boost': {
            // رفع المستوى + زيادة جميع الإحصائيات بنسبة 5% لكل مستوى
            const levels = Math.floor(v);
            const mult   = Math.pow(1.05, levels); // 5% مركّبة
            await pool.execute(`
                UPDATE players SET
                    level = level + ?,
                    hp    = ROUND(hp    * ?),
                    atk   = ROUND(atk   * ?),
                    def   = ROUND(def   * ?),
                    spd   = ROUND(spd   * ?),
                    acc   = ROUND(acc   * ?),
                    mag   = ROUND(mag   * ?),
                    sta   = ROUND(sta   * ?)
                WHERE telegram_id = ?
            `, [levels, mult, mult, mult, mult, mult, mult, mult, tid]);
            break;
        }

        case 'health': {
            const amount = product.effect_type === 'percent'
                ? Math.round(player.hp * (v / 100))
                : Math.round(v);
            await pool.execute(`UPDATE players SET hp = hp + ? WHERE telegram_id = ?`, [amount, tid]);
            break;
        }

        case 'attack': {
            const amount = product.effect_type === 'percent'
                ? Math.round(player.atk * (v / 100))
                : Math.round(v);
            await pool.execute(`UPDATE players SET atk = atk + ? WHERE telegram_id = ?`, [amount, tid]);
            break;
        }

        case 'defense': {
            const amount = product.effect_type === 'percent'
                ? Math.round(player.def * (v / 100))
                : Math.round(v);
            await pool.execute(`UPDATE players SET def = def + ? WHERE telegram_id = ?`, [amount, tid]);
            break;
        }

        case 'magic': {
            const amount = product.effect_type === 'percent'
                ? Math.round(player.mag * (v / 100))
                : Math.round(v);
            await pool.execute(`UPDATE players SET mag = mag + ? WHERE telegram_id = ?`, [amount, tid]);
            break;
        }
    }
}

module.exports = { handleStore, handleStoreCallback, handleStoreEffectTypeCallback };