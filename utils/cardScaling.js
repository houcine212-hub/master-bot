/**
 * ============================================================
 * ملف: utils/cardScaling.js
 * الوصف: نظام التطوير التلقائي لبطاقات اللاعب
 * ============================================================
 */

async function syncCardScaling(pool, userId, newIdCard) {
    try {
        const [snapRows] = await pool.execute(
            'SELECT * FROM player_id_snapshot WHERE player_telegram_id = ?',
            [userId]
        );

        const isFirstTime = snapRows.length === 0;

        if (isFirstTime) {
            await _initializeScaling(pool, userId, newIdCard);
            return { status: 'first_time', cardsUpdated: 0, changes: {} };
        }

        const old = snapRows[0];

        const changed =
            Number(old.snap_atk) !== Number(newIdCard.atk) ||
            Number(old.snap_def) !== Number(newIdCard.def) ||
            Number(old.snap_mag) !== Number(newIdCard.mag) ||
            Number(old.snap_spd) !== Number(newIdCard.spd) ||
            Number(old.snap_acc) !== Number(newIdCard.acc);

        if (!changed) {
            return { status: 'no_change', cardsUpdated: 0, changes: {} };
        }

        const ratios = {
            atk: old.snap_atk > 0 ? newIdCard.atk / old.snap_atk : 1,
            def: old.snap_def > 0 ? newIdCard.def / old.snap_def : 1,
            mag: old.snap_mag > 0 ? newIdCard.mag / old.snap_mag : 1,
            spd: old.snap_spd > 0 ? newIdCard.spd / old.snap_spd : 1,
            acc: old.snap_acc > 0 ? newIdCard.acc / old.snap_acc : 1,
        };

        const changes = {};
        if (ratios.atk !== 1) changes.atk = { from: old.snap_atk, to: newIdCard.atk, ratio: ratios.atk };
        if (ratios.def !== 1) changes.def = { from: old.snap_def, to: newIdCard.def, ratio: ratios.def };
        if (ratios.mag !== 1) changes.mag = { from: old.snap_mag, to: newIdCard.mag, ratio: ratios.mag };
        if (ratios.spd !== 1) changes.spd = { from: old.snap_spd, to: newIdCard.spd, ratio: ratios.spd };
        if (ratios.acc !== 1) changes.acc = { from: old.snap_acc, to: newIdCard.acc, ratio: ratios.acc };

        // ✅ الإصلاح النهائي: نجيب كل البطاقات بدون فلتر نصي في SQL
        // ونفلتر type في JavaScript لتجنب مشاكل الـ collation كلياً
        const [allCards] = await pool.execute(`
            SELECT pc.card_id, v.type, v.value, v.spd, v.acc
            FROM player_cards pc
            JOIN view_all_cards v ON pc.card_id = v.id
            WHERE pc.player_id = ?
        `, [userId]);

        const ownedCards = allCards.filter(c => c.type !== 'id_card');

        let cardsUpdated = 0;

        for (const card of ownedCards) {
            const [scalingRows] = await pool.execute(
                'SELECT * FROM player_card_scaling WHERE player_telegram_id = ? AND card_id = ?',
                [userId, card.card_id]
            );

            const current = scalingRows.length > 0 ? scalingRows[0] : {
                eff_value: card.value,
                eff_spd:   card.spd,
                eff_acc:   card.acc,
            };

            let newValue = current.eff_value;
            let newSpd   = current.eff_spd;
            let newAcc   = current.eff_acc;

            switch (card.type) {
                case 'attack':  newValue = Math.round(current.eff_value * ratios.atk); break;
                case 'defense': newValue = Math.round(current.eff_value * ratios.def); break;
                case 'magic':   newValue = Math.round(current.eff_value * ratios.mag); break;
            }

            newSpd = Math.round(current.eff_spd * ratios.spd);
            newAcc = Math.round(current.eff_acc * ratios.acc);

            newValue = Math.max(0, newValue);
            newSpd   = Math.max(0, newSpd);
            newAcc   = Math.max(0, newAcc);

            await pool.execute(`
                INSERT INTO player_card_scaling
                    (player_telegram_id, card_id, eff_value, eff_spd, eff_acc)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    eff_value = VALUES(eff_value),
                    eff_spd   = VALUES(eff_spd),
                    eff_acc   = VALUES(eff_acc)
            `, [userId, card.card_id, newValue, newSpd, newAcc]);

            cardsUpdated++;
        }

        await pool.execute(`
            UPDATE player_id_snapshot
            SET snap_atk=?, snap_def=?, snap_mag=?, snap_spd=?, snap_acc=?
            WHERE player_telegram_id=?
        `, [newIdCard.atk, newIdCard.def, newIdCard.mag, newIdCard.spd, newIdCard.acc, userId]);

        return { status: 'updated', cardsUpdated, changes };

    } catch (err) {
        console.error('[cardScaling] خطأ أثناء المزامنة:', err.message);
        return { status: 'error', cardsUpdated: 0, changes: {} };
    }
}

async function _initializeScaling(pool, userId, idCard) {
    // ✅ نفس الإصلاح: فلترة id_card في JavaScript
    const [allCards] = await pool.execute(`
        SELECT pc.card_id, v.type, v.value, v.spd, v.acc
        FROM player_cards pc
        JOIN view_all_cards v ON pc.card_id = v.id
        WHERE pc.player_id = ?
    `, [userId]);

    const ownedCards = allCards.filter(c => c.type !== 'id_card');

    for (const card of ownedCards) {
        await pool.execute(`
            INSERT IGNORE INTO player_card_scaling
                (player_telegram_id, card_id, eff_value, eff_spd, eff_acc)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, card.card_id, card.value, card.spd, card.acc]);
    }

    await pool.execute(`
        INSERT INTO player_id_snapshot
            (player_telegram_id, snap_atk, snap_def, snap_mag, snap_spd, snap_acc)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [userId, idCard.atk, idCard.def, idCard.mag, idCard.spd, idCard.acc]);
}

async function getEffectiveCard(pool, userId, cardId, baseCard) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM player_card_scaling WHERE player_telegram_id = ? AND card_id = ?',
            [userId, cardId]
        );

        if (rows.length === 0) return baseCard;

        return {
            ...baseCard,
            value: rows[0].eff_value,
            spd:   rows[0].eff_spd,
            acc:   rows[0].eff_acc,
        };
    } catch (err) {
        console.error('[cardScaling] خطأ getEffectiveCard:', err.message);
        return baseCard;
    }
}

function buildSyncMessage(result) {
    if (result.status === 'no_change') return null;
    if (result.status === 'first_time') return '✅ تم تسجيل إحصائيات بطاقتك التعريفية كنقطة بداية.';

    const c = result.changes;
    let msg = `🔄 **تم تطوير بطاقاتك تلقائياً!**\n\n`;

    if (c.atk) msg += `⚔️ هجوم: ${c.atk.from} → **${c.atk.to}** (×${c.atk.ratio.toFixed(2)})\n`;
    if (c.def) msg += `🛡️ دفاع: ${c.def.from} → **${c.def.to}** (×${c.def.ratio.toFixed(2)})\n`;
    if (c.mag) msg += `✨ سحر: ${c.mag.from} → **${c.mag.to}** (×${c.mag.ratio.toFixed(2)})\n`;
    if (c.spd) msg += `⚡ سرعة: ${c.spd.from} → **${c.spd.to}** (×${c.spd.ratio.toFixed(2)})\n`;
    if (c.acc) msg += `🎯 دقة: ${c.acc.from} → **${c.acc.to}** (×${c.acc.ratio.toFixed(2)})\n`;

    msg += `\n📦 عدد البطاقات المحدّثة: **${result.cardsUpdated}**`;

    return msg;
}

module.exports = { syncCardScaling, getEffectiveCard, buildSyncMessage };