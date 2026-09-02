const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("❌ CRITICAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing!");
    process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Helper to validate Telegram initData securely
function validateTelegramInitData(initData, botToken) {
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const dataCheckString = Array.from(urlParams.entries())
            .sort(([a], [b]) => a < b ? -1 : 1)
            .map(([key, val]) => `${key}=${val}`)
            .join('\n');
            
        const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
        
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

function parseTelegramInitData(initData) {
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');
    return userStr ? JSON.parse(userStr) : null;
}

app.post('/api/verify-device', async (req, res) => {
    try {
        const { initData, device_fp } = req.body;
        const botToken = process.env.BOT_TOKEN; 
        if (!initData || !device_fp || !botToken) {
            return res.status(400).json({ success: false, message: 'Missing initData, device_fp, or BOT_TOKEN' });
        }

        // 1. SECURELY VALIDATE THE USER (Prevents spoofing)
        const isValid = validateTelegramInitData(initData, botToken);
        if (!isValid) {
            return res.status(401).json({ success: false, message: 'Invalid Telegram initData signature' });
        }

        const userData = parseTelegramInitData(initData);
        if (!userData || !userData.id) {
            return res.status(400).json({ success: false, message: 'User data not found in initData' });
        }

        const telegram_id = String(userData.id);

        // 2. PROCESS DEVICE VERIFICATION
        const deviceKey = `device_${device_fp}`;
        const deviceRef = db.collection('devices').doc(deviceKey);
        const deviceDoc = await deviceRef.get();

        let isDuplicate = false;
        let referralBlocked = false;

        if (deviceDoc.exists) {
            const existingUserId = deviceDoc.data().telegram_id;
            if (String(existingUserId) !== telegram_id) {
                isDuplicate = true;
                referralBlocked = true;
                
                await db.collection('users').doc(telegram_id).set({
                    device_fp: device_fp,
                    device_verified: 'yes',
                    referral_blocked: 'yes',
                    verified_at: Date.now()
                }, { merge: true });
            }
        }

        if (!isDuplicate) {
            await db.collection('devices').doc(deviceKey).set({
                telegram_id: telegram_id,
                device_fp: device_fp,
                created_at: Date.now()
            });

            await db.collection('users').doc(telegram_id).set({
                device_fp: device_fp,
                device_verified: 'yes',                referral_blocked: 'no',
                verified_at: Date.now()
            }, { merge: true });
        }

        res.json({ 
            success: true, 
            verified: true,
            duplicate: isDuplicate,
            referralBlocked: referralBlocked
        });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running securely on port ${PORT}`);
});
