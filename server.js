const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// CHECK ENVIRONMENT VARIABLES FIRST
console.log('🔍 Checking environment variables...');
console.log('FIREBASE_SERVICE_ACCOUNT exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log('BOT_TOKEN exists:', !!process.env.BOT_TOKEN);

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('❌ ERROR: FIREBASE_SERVICE_ACCOUNT is missing!');
    process.exit(1);
}

if (!process.env.BOT_TOKEN) {
    console.error('❌ ERROR: BOT_TOKEN is missing!');
    process.exit(1);
}

// Initialize Firebase
try {
    console.log('🔧 Parsing Firebase service account...');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase account parsed successfully');
    
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const db = admin.firestore();
    console.log('✅ Firebase initialized');
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    console.error('Check your FIREBASE_SERVICE_ACCOUNT environment variable!');
    process.exit(1);
}

const db = admin.firestore();

// ROOT ROUTE
app.get('/', (req, res) => {
    res.send('✅ Server is running! Visit /api/verify-device to verify.');
});

// VERIFICATION ENDPOINT
app.post('/api/verify-device', async (req, res) => {
    console.log('📥 Received verification request');
        try {
        const { initData, device_fp } = req.body;
        const botToken = process.env.BOT_TOKEN;

        if (!initData || !device_fp || !botToken) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }

        // Validate Telegram data
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
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }

        const userStr = new URLSearchParams(initData).get('user');
        const userData = JSON.parse(userStr);
        const telegram_id = String(userData.id);

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
                }, { merge: true });            }
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

        res.json({ 
            success: true, 
            verified: true,
            duplicate: isDuplicate,
            referralBlocked: referralBlocked
        });

    } catch (error) {
        console.error('❌ Verification error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
