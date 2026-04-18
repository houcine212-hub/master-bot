/**
 * ============================================================
 * ملف: handlers/botAI.js
 * الوصف: نظام الذكاء الاصطناعي للبوت - Master Card Game
 * ============================================================
 *
 * خريطة مستويات الذكاء:
 *  Level 1 → عشوائي تماماً (Random)
 *  Level 2 → يختار أعلى قيمة دائماً (Greedy)
 *  Level 3 → يراعي ميكانيكا الدقة/السرعة (Smart)
 *  Level 4 → يتكيف مع نسبة HP والوضع الحالي (Adaptive)
 *  Level 5+ → يتتبع أنماط اللاعب + مضاعف قوة للمستويات العالية (Tactical)
 *
 * قواعد قتال اللعبة (مرجع):
 *  - إذا acc المهاجم > spd المدافع  → ضرر كامل (card.value)
 *  - إذا acc المهاجم ≤ spd المدافع  → ضرر = attack_value - defense_value  (بحد أدنى 0)
 *
 * لإضافة نوع بطاقة جديد مستقبلاً:
 *  - أضف type جديد في دالة _filterByType()
 *  - أضف منطق نقاط خاص به في _scoreCard()
 * ============================================================
 */

// ====== خريطة الصعوبة ======
const DIFFICULTY_MAP = {
    1: 'random',
    2: 'greedy',
    3: 'smart',
    4: 'adaptive',
};
// Level 5 وما فوق يصبح 'tactical' تلقائياً

class BotAI {
    /**
     * @param {number} level        - مستوى البوت (يحدد الذكاء + مضاعف القوة)
     * @param {Array}  deck         - بطاقات أكشن البوت من قاعدة البيانات
     * @param {Object} playerIdCard - إحصائيات بطاقة هوية اللاعب (hp/atk/def/spd/acc...)
     */
    constructor(level, deck, playerIdCard) {
        this.level       = level;
        this.deck        = [...deck]; // نسخة كاملة لا تُعدَّل
        this.playerStats = playerIdCard;
        this.turnHistory = []; // [{playerCard, botCard}, ...] - آخر 15 دور

        // تحديد مستوى الصعوبة
        this.difficulty = level >= 5
            ? 'tactical'
            : (DIFFICULTY_MAP[level] ?? 'adaptive');

        // مضاعف قوة للمستويات 6+ : كل مستوى فوق 5 يضيف 10% للإحصائيات
        // Level 5 = x1.0 | Level 6 = x1.1 | Level 7 = x1.2 ...
        this.statMultiplier = level >= 6 ? 1.0 + (level - 5) * 0.10 : 1.0;
    }

    // ============================================================
    // ▶ الدالة الرئيسية: اختيار البطاقة المناسبة لكل دور
    // ============================================================
    /**
     * @param {string} neededType - 'attack' (دور البوت للهجوم) | 'defense' (البوت يدافع)
     * @param {Object} context    - سياق المعركة:
     *   {
     *     playerAttackCard: Object|null,  // بطاقة الهجوم التي لعبها اللاعب (متاحة فقط عند الدفاع)
     *     botHp:        number,           // صحة البوت الحالية
     *     botMaxHp:     number,           // أقصى صحة للبوت
     *     playerHp:     number,           // صحة اللاعب الحالية
     *     playerMaxHp:  number,           // أقصى صحة للاعب
     *     botStamina:   number,           // طاقة البوت الحالية
     *     botMana:      number,           // مانا البوت الحالية
     *   }
     * @returns {Object|null} البطاقة المختارة (مع تطبيق مضاعف القوة إذا لزم) أو null
     */
    chooseCard(neededType, context) {
        // 1. تصفية البطاقات المتاحة (النوع + الموارد الكافية)
        const available = this._filterAvailable(neededType, context);
        if (available.length === 0) return null;

        // 2. تطبيق خوارزمية الاختيار بحسب مستوى الصعوبة
        let chosen;
        switch (this.difficulty) {
            case 'random':   chosen = this._randomPick(available);                         break;
            case 'greedy':   chosen = this._greedyPick(available);                         break;
            case 'smart':    chosen = this._smartPick(available, neededType, context);     break;
            case 'adaptive': chosen = this._adaptivePick(available, neededType, context);  break;
            case 'tactical': chosen = this._tacticalPick(available, neededType, context);  break;
            default:         chosen = this._tacticalPick(available, neededType, context);
        }

        if (!chosen) return null;

        // 3. تطبيق مضاعف القوة (Level 6+) على نسخة من البطاقة لا تُعدّل الأصل
        return this._applyMultiplier(chosen);
    }

    // ============================================================
    // ▶ تسجيل نتيجة الدور (لتعلم أنماط اللاعب في المستويات العالية)
    // ============================================================
    /**
     * يُستدعى بعد كل جولة قتالية
     * @param {Object|null} playerCard - البطاقة التي لعبها اللاعب هذا الدور
     * @param {Object|null} botCard    - البطاقة التي اختارها البوت
     */
    recordTurn(playerCard, botCard) {
        if (!playerCard) return;
        this.turnHistory.push({ playerCard, botCard });
        if (this.turnHistory.length > 15) this.turnHistory.shift();
    }

    // ============================================================
    // ▶ معلومات لعرضها في رسائل التليجرام
    // ============================================================
    getDifficultyLabel() {
        const labels = {
            random:   '🎲 عشوائي',
            greedy:   '💪 عدواني',
            smart:    '🧠 ذكي',
            adaptive: '🔄 متكيف',
            tactical: '🎯 تكتيكي',
        };
        const bonus = this.statMultiplier > 1.0
            ? ` (+${Math.round((this.statMultiplier - 1) * 100)}% قوة)`
            : '';
        return (labels[this.difficulty] ?? '🎯 تكتيكي') + bonus;
    }

    // ============================================================
    // ===== خوارزميات الاختيار (private) =====
    // ============================================================

    /**
     * Level 1 - عشوائي تماماً
     * البوت يختار بطاقة عشوائية بدون أي استراتيجية
     */
    _randomPick(cards) {
        return cards[Math.floor(Math.random() * cards.length)];
    }

    /**
     * Level 2 - جشع (Greedy)
     * يختار دائماً البطاقة ذات أعلى قيمة (value) بغض النظر عن أي شيء آخر
     */
    _greedyPick(cards) {
        return cards.reduce((best, c) => c.value > best.value ? c : best, cards[0]);
    }

    /**
     * Level 3 - ذكي (Smart)
     * يفهم ميكانيكا الدقة/السرعة ويستغلها:
     *   هجوم: يختار بطاقة acc > spd اللاعب → ضرر كامل مضمون
     *   دفاع: إذا عرف بطاقة اللاعب، يختار بطاقة spd >= acc اللاعب → يُفعّل الدفاع
     */
    _smartPick(cards, neededType, context) {
        if (neededType === 'attack') {
            const playerSpd = this.playerStats.spd ?? 0;
            // بطاقات تضمن الإصابة الكاملة
            const guaranteed = cards.filter(c => c.acc > playerSpd);
            const pool = guaranteed.length > 0 ? guaranteed : cards;
            return pool.reduce((best, c) => c.value > best.value ? c : best, pool[0]);

        } else {
            const playerAcc = context.playerAttackCard?.acc ?? 0;
            // بطاقات تُفعّل قانون التخفيف (spd >= acc اللاعب)
            const canMitigate = cards.filter(c => c.spd >= playerAcc);
            const pool = canMitigate.length > 0 ? canMitigate : cards;
            return pool.reduce((best, c) => c.value > best.value ? c : best, pool[0]);
        }
    }

    /**
     * Level 4 - متكيف (Adaptive)
     * يراعي وضع المعركة ويضبط استراتيجيته:
     *   - إذا HP اللاعب < 25% → هجوم شرس بأقوى بطاقة (أنهِ المعركة)
     *   - إذا HP البوت < 30% → في الهجوم: وازن بين القوة والسرعة | في الدفاع: ادفع بكل قوة
     *   - غير ذلك → استخدم استراتيجية Level 3
     */
    _adaptivePick(cards, neededType, context) {
        const botHpPct    = (context.botHp    ?? 1) / (context.botMaxHp    ?? 1);
        const playerHpPct = (context.playerHp ?? 1) / (context.playerMaxHp ?? 1);

        if (neededType === 'attack') {
            // اللاعب على وشك السقوط → اضرب بأقوى بطاقة
            if (playerHpPct < 0.25) {
                return cards.reduce((best, c) => c.value > best.value ? c : best, cards[0]);
            }
            // البوت في خطر → اختر بطاقة توازن بين الضرر والسرعة (تضمن الإصابة وتحافظ على الزخم)
            if (botHpPct < 0.30) {
                return cards.reduce((best, c) =>
                    (c.acc + c.value) > (best.acc + best.value) ? c : best, cards[0]);
            }
        } else {
            // البوت في خطر → استخدم أعلى دفاع متاح
            if (botHpPct < 0.30) {
                return cards.reduce((best, c) => c.value > best.value ? c : best, cards[0]);
            }
        }

        return this._smartPick(cards, neededType, context);
    }

    /**
     * Level 5+ - تكتيكي (Tactical)
     * يتتبع أنماط اللاعب ويحسب نقاطاً لكل بطاقة:
     *
     * هجوم: score = value + مكافأة(إذا acc > متوسط spd دفاع اللاعب) - عقوبة التكلفة
     * دفاع: score = -الضرر_المتوقع + مكافأة(إذا spd >= acc اللاعب) - عقوبة التكلفة
     *
     * 5% احتمال "مفاجأة" لمنع اللاعب من التنبؤ الكامل
     */
    _tacticalPick(cards, neededType, context) {
        // لا تتوقع كل الوقت - 5% عشوائية للإثارة
        if (Math.random() < 0.05) return this._randomPick(cards);

        const pattern = this._analyzePlayerPattern();

        if (neededType === 'attack') {
            const expectedDefSpd = pattern.avgDefSpd ?? this.playerStats.spd ?? 0;

            const scored = cards.map(c => {
                const guaranteedHit = c.acc > expectedDefSpd;
                const score = c.value
                    + (guaranteedHit ? c.value * 0.6 : 0)    // مكافأة: ضرر كامل مضمون
                    - (c.stamina_cost ?? 0) * 1.5             // عقوبة: استهلاك الطاقة
                    - (c.mana_cost    ?? 0) * 1.5;
                return { card: c, score };
            });

            scored.sort((a, b) => b.score - a.score);
            return scored[0].card;

        } else {
            const playerAcc   = context.playerAttackCard?.acc   ?? (pattern.avgAttackAcc   ?? 100);
            const playerValue = context.playerAttackCard?.value ?? (pattern.avgAttackValue ?? 50);

            const scored = cards.map(c => {
                const canMitigate  = c.spd >= playerAcc;
                const expectedDmg  = canMitigate
                    ? Math.max(0, playerValue - c.value)
                    : playerValue; // لا يوجد تخفيف إذا كانت السرعة منخفضة
                const score = -expectedDmg                    // نريد تقليل الضرر
                    + (canMitigate ? 40 : 0)                  // مكافأة: تفعيل التخفيف
                    - (c.stamina_cost ?? 0) * 1.0
                    - (c.mana_cost    ?? 0) * 1.0;
                return { card: c, score };
            });

            scored.sort((a, b) => b.score - a.score);
            return scored[0].card;
        }
    }

    // ============================================================
    // ===== دوال مساعدة (private) =====
    // ============================================================

    /**
     * تصفية البطاقات المتاحة للاستخدام
     * يدعم تلقائياً أي نوع بطاقة يُضاف مستقبلاً:
     *   لإضافة نوع هجوم جديد → أضفه في قائمة ATTACK_TYPES
     *   لإضافة نوع دفاع جديد → أضفه في قائمة DEFENSE_TYPES
     */
    _filterAvailable(neededType, context) {
        // ▼ قابل للتوسعة: أضف أنواع بطاقات جديدة هنا ▼
        const ATTACK_TYPES  = ['attack', 'magic'];   // أنواع تُستخدم للهجوم
        const DEFENSE_TYPES = ['defense'];            // أنواع تُستخدم للدفاع

        const validTypes = neededType === 'attack' ? ATTACK_TYPES : DEFENSE_TYPES;

        return this.deck.filter(c =>
            validTypes.includes(c.type)
            && (context.botStamina ?? Infinity) >= (c.stamina_cost ?? 0)
            && (context.botMana    ?? Infinity) >= (c.mana_cost    ?? 0)
        );
    }

    /** تحليل أنماط اللاعب من سجل الأدوار الماضية */
    _analyzePlayerPattern() {
        if (this.turnHistory.length === 0) return {};

        const avg = (arr, key) => arr.length > 0
            ? arr.reduce((sum, c) => sum + (c[key] ?? 0), 0) / arr.length
            : null;

        const allPlayerCards   = this.turnHistory.map(t => t.playerCard).filter(Boolean);
        const attackCards      = allPlayerCards.filter(c => c.type === 'attack' || c.type === 'magic');
        const defenseCards     = allPlayerCards.filter(c => c.type === 'defense');

        return {
            avgAttackAcc:   avg(attackCards,  'acc'),
            avgAttackValue: avg(attackCards,  'value'),
            avgDefSpd:      avg(defenseCards, 'spd'),
            avgDefValue:    avg(defenseCards, 'value'),
        };
    }

    /** تطبيق مضاعف القوة على بطاقة (Level 6+) - يُعيد نسخة جديدة ولا يعدّل الأصل */
    _applyMultiplier(card) {
        if (this.statMultiplier === 1.0) return card;
        return {
            ...card,
            value: Math.round(card.value * this.statMultiplier),
            acc:   Math.round(card.acc   * this.statMultiplier),
            spd:   Math.round(card.spd   * this.statMultiplier),
            // ملاحظة: name وtype وتكاليف الموارد لا تتغير
        };
    }
}

module.exports = { BotAI };
