const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

// ================================
// MIDDLEWARE
// ================================

app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.options('*', cors());

app.use(express.json({
    limit: '1mb'
}));

// ================================
// FIREBASE INITIALIZATION
// ================================

let db = null;

try {
    if (!admin.apps.length) {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is missing');
        }

        const serviceAccount = JSON.parse(
            process.env.FIREBASE_SERVICE_ACCOUNT
        );

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }

    db = admin.firestore();

    console.log('✅ Firebase initialized');
} catch (error) {
    console.error('🔥 Firebase initialization failed:', error.message);
}

// ================================
// HOMEPAGE
// ================================

app.get('/', (req, res) => {
    res.status(200).send('✅ Server is awake and ready!');
});

// ================================
// HEALTH CHECK
// ================================

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        server: 'online',
        firebase: db !== null
    });
});

// ================================
// TELEGRAM INIT DATA VALIDATION
// ================================

function validateTelegramInitData(initData, botToken) {
    if (!initData || !botToken) {
        return {
            valid: false,
            reason: 'Missing initData or BOT_TOKEN'
        };
    }

    try {
        const urlParams = new URLSearchParams(initData);

        const receivedHash = urlParams.get('hash');

        if (!receivedHash) {
            return {
                valid: false,
                reason: 'Missing Telegram hash'
            };
        }

        urlParams.delete('hash');

        const dataCheckString = Array.from(urlParams.entries())
            .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        // Telegram Web Apps validation
        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        const valid =
            receivedHash.length === calculatedHash.length &&
            crypto.timingSafeEqual(
                Buffer.from(receivedHash),
                Buffer.from(calculatedHash)
            );

        return {
            valid,
            reason: valid ? null : 'Invalid Telegram signature'
        };

    } catch (error) {
        return {
            valid: false,
            reason: error.message
        };
    }
}

// ================================
// VERIFY DEVICE
// ================================

app.post('/api/verify-device', async (req, res) => {
    try {
        console.log('📥 Verification request received');

        const { initData, device_fp } = req.body || {};

        // --------------------------------
        // Validate request
        // --------------------------------

        if (!initData || !device_fp) {
            return res.status(400).json({
                success: false,
                message: 'Missing initData or device_fp'
            });
        }

        if (typeof device_fp !== 'string' || device_fp.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Invalid device fingerprint'
            });
        }

        // --------------------------------
        // Environment variables
        // --------------------------------

        const botToken = process.env.BOT_TOKEN;

        if (!botToken) {
            console.error('❌ BOT_TOKEN is missing');

            return res.status(500).json({
                success: false,
                message: 'Server configuration error'
            });
        }

        // --------------------------------
        // Validate Telegram signature
        // --------------------------------

        const telegramValidation = validateTelegramInitData(
            initData,
            botToken
        );

        if (!telegramValidation.valid) {
            console.error(
                '⚠️ Telegram validation failed:',
                telegramValidation.reason
            );

            return res.status(401).json({
                success: false,
                message: 'Invalid Telegram authentication data'
            });
        }

        // --------------------------------
        // Get Telegram user
        // --------------------------------

        const params = new URLSearchParams(initData);
        const userStr = params.get('user');

        if (!userStr) {
            return res.status(400).json({
                success: false,
                message: 'Telegram user data is missing'
            });
        }

        let userData;

        try {
            userData = JSON.parse(userStr);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Telegram user data'
            });
        }

        if (!userData || !userData.id) {
            return res.status(400).json({
                success: false,
                message: 'Telegram user ID is missing'
            });
        }

        const telegram_id = String(userData.id);

        // --------------------------------
        // Firebase availability
        // --------------------------------

        if (!db) {
            console.error('❌ Firebase is not initialized');

            return res.status(503).json({
                success: false,
                message: 'Database temporarily unavailable'
            });
        }

        // --------------------------------
        // Device lookup
        // --------------------------------

        const deviceKey = `device_${device_fp}`;

        const deviceRef = db
            .collection('devices')
            .doc(deviceKey);

        const deviceDoc = await deviceRef.get();

        let isDuplicate = false;

        if (deviceDoc.exists) {
            const existingUserId = deviceDoc.data().telegram_id;

            if (
                existingUserId &&
                String(existingUserId) !== telegram_id
            ) {
                isDuplicate = true;
            }
        }

        // --------------------------------
        // Save device
        // --------------------------------

        await deviceRef.set({
            telegram_id,
            device_fp,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),

            ...(deviceDoc.exists
                ? {}
                : {
                    created_at:
                        admin.firestore.FieldValue.serverTimestamp()
                })
        }, {
            merge: true
        });

        // --------------------------------
        // Save user
        // --------------------------------

        await db
            .collection('users')
            .doc(telegram_id)
            .set({
                device_fp,
                device_verified: 'yes',
                referral_blocked: isDuplicate ? 'yes' : 'no',
                verified_at:
                    admin.firestore.FieldValue.serverTimestamp()
            }, {
                merge: true
            });

        // --------------------------------
        // Success
        // --------------------------------

        console.log(
            `✅ Device verified: ${telegram_id} | Duplicate: ${isDuplicate}`
        );

        return res.status(200).json({
            success: true,
            duplicate: isDuplicate
        });

    } catch (error) {
        console.error(
            '💥 Verification error:',
            error
        );

        return res.status(500).json({
            success: false,
            message: 'Verification failed'
        });
    }
});

// ================================
// 404 HANDLER
// ================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// ================================
// GLOBAL ERROR HANDLER
// ================================

app.use((err, req, res, next) => {
    console.error('💥 Express error:', err);

    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// ================================
// START SERVER
// ================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
