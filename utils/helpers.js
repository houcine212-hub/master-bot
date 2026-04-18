const crypto = require('crypto');

function generatePlayerId() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateHash(cardId) {
    return crypto.createHmac('sha256', process.env.SECRET_KEY).update(cardId).digest('hex');
}

module.exports = { generatePlayerId, generateHash };