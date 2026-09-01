const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// API Endpoint: Verify Device
app.post('/api/verify-device', async (req, res) => {
    try {
        const { telegram_id, device_fp } = req.body;
        
        if (!telegram_id || !device_fp) {
            return res.status(400).json({ success: false, message: 'Missing data' });
        }

        const deviceKey = `device_${device_fp}`;
        const deviceRef = db.collection('devices').doc(deviceKey);
        const deviceDoc = await deviceRef.get();

        let isDuplicate = false;
        let referralBlocked = false;

        if (deviceDoc.exists) {
            const existingUserId = deviceDoc.data().telegram_id;
            
            if (String(existingUserId) !== String(telegram_id)) {
                // DUPLICATE DEVICE - Allow but block referrals
                isDuplicate = true;
                referralBlocked = true;
                
                // Save to user data
                await db.collection('users').doc(String(telegram_id)).set({
                    device_fp: device_fp,
                    device_verified: 'yes',
                    referral_blocked: 'yes',
                    verified_at: Date.now()
                }, { merge: true });

                console.log(`️ DUPLICATE: User ${telegram_id} on device ${device_fp}`);
            }
        }
        if (!isDuplicate) {
            // NEW DEVICE - Full verification
            await db.collection('devices').doc(deviceKey).set({
                telegram_id: telegram_id,
                device_fp: device_fp,
                created_at: Date.now()
            });

            await db.collection('users').doc(String(telegram_id)).set({
                device_fp: device_fp,
                device_verified: 'yes',
                referral_blocked: 'no',
                verified_at: Date.now()
            }, { merge: true });

            console.log(`✅ VERIFIED: User ${telegram_id}`);
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

// API Endpoint: Check Verification Status
app.get('/api/check-verification/:user_id', async (req, res) => {
    try {
        const userId = req.params.user_id;
        const userRef = db.collection('users').doc(String(userId));
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            const userData = userDoc.data();
            res.json({
                verified: userData.device_verified === 'yes',
                referralBlocked: userData.referral_blocked === 'yes',
                deviceFp: userData.device_fp
            });
        } else {
            res.json({ verified: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
});
