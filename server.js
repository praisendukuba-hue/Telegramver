hereconst express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Enhanced CORS - allow requests from Blogspot
app.use(cors({
    origin: '*', // Allow all origins (Blogspot, Telegram, etc.)
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Handle preflight OPTIONS requests
app.options('*', (req, res) => {
    res.sendStatus(200);
});

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

// Health check endpoint (GET request to test if server is alive)
app.get('/', (req, res) => {
    res.json({ status: 'Server is running!', timestamp: new Date().toISOString() });
});

app.post('/api/verify-device', async (req, res) => {
    console.log('📥 Received verification request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { initData, device_fp } = req.body;
        const botToken = process.env.BOT_TOKEN; 

        if (!initData) {
            console.log('❌ Missing initData');
            return res.status(400).json({ success: false, message: 'Missing initData from Web App' });
        }
        if (!device_fp) {
            console.log('❌ Missing device_fp');
            return res.status(400).json({ success: false, message: 'Missing device_fp from Web App' });
        }
        if (!botToken) {
            console.log('❌ Missing BOT_TOKEN in environment');
            return res.status(500).json({ success: false, message: 'Missing BOT_TOKEN in server environment variables' });
        }

        console.log('✅ All required fields present');

        // 1. SECURELY VALIDATE THE USER
        const isValid = validateTelegramInitData(initData, botToken);
        if (!isValid) {
            console.log(' Invalid initData signature');
            return res.status(401).json({ success: false, message: 'Invalid Telegram initData signature' });
        }

        console.log('✅ initData validated successfully');

        const userData = parseTelegramInitData(initData);
        if (!userData || !userData.id) {
            console.log('❌ User data not found');
            return res.status(400).json({ success: false, message: 'User data not found in initData' });
        }
        const telegram_id = String(userData.id);
        console.log(`👤 Processing verification for user: ${telegram_id}`);

        // 2. PROCESS DEVICE VERIFICATION
        const deviceKey = `device_${device_fp}`;
        const deviceRef = db.collection('devices').doc(deviceKey);
        const deviceDoc = await deviceRef.get();

        let isDuplicate = false;
        let referralBlocked = false;

        if (deviceDoc.exists) {
            const existingUserId = deviceDoc.data().telegram_id;
            if (String(existingUserId) !== telegram_id) {
                console.log(`⚠️ DUPLICATE DEVICE: User ${telegram_id} on device ${device_fp}`);
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
            console.log(`✅ NEW DEVICE: User ${telegram_id} verified on device ${device_fp}`);
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

        console.log('✅ Verification successful');
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
    console.log(` Backend running securely on port ${PORT}`);
});
