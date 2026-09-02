const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// 1. CHECK ENVIRONMENT VARIABLES
if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.BOT_TOKEN) {
    console.error("Missing environment variables!");
    process.exit(1);
}

// 2. INITIALIZE FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 3. HOMEPAGE ROUTE (This fixes the "Not Found" error!)
app.get('/', (req, res) => {
    res.send("✅ Server is awake and running!");
});

// 4. VERIFICATION ROUTE
app.post('/api/verify-device', async (req, res) => {
    try {
        const { initData, device_fp } = req.body;
        const botToken = process.env.BOT_TOKEN;

        if (!initData || !device_fp) {
            return res.status(400).json({ success: false, message: 'Missing data' });
        }

        // Validate Telegram signature
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const dataCheckString = Array.from(urlParams.entries())
            .sort(([a], [b]) => a < b ? -1 : 1)
            .map(([key, val]) => `${key}=${val}`)
            .join('\n');
            
        const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
        
        if (calculatedHash !== hash) {
            return res.status(401).json({ success: false, message: 'Invalid signature' });        }

        const userStr = new URLSearchParams(initData).get('user');
        const userData = JSON.parse(userStr);
        const telegram_id = String(userData.id);

        // Check for duplicate device
        const deviceKey = `device_${device_fp}`;
        const deviceDoc = await db.collection('devices').doc(deviceKey).get();

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
                device_verified: 'yes',
                referral_blocked: 'no',
                verified_at: Date.now()
            }, { merge: true });
        }

        res.json({ success: true, duplicate: isDuplicate, referralBlocked: referralBlocked });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
