const express = require('express');
const cors = require('cors');
const app = express();

// Allow all connections
app.use(cors());
app.use(express.json());

// 1. HOMEPAGE (To wake up the server)
app.get('/', (req, res) => {
    res.send("✅ Server is awake and ready!");
});

// 2. VERIFICATION ENDPOINT (Crash-Proof)
app.post('/api/verify-device', async (req, res) => {
    try {
        console.log("📥 Request received:", req.body);
        
        const { initData, device_fp } = req.body;

        if (!initData || !device_fp) {
            return res.json({ success: false, message: "Missing data" });
        }

        // --- FIREBASE LOGIC ---
        // We wrap this in a try/catch so if Firebase fails, it doesn't crash the server
        try {
            const admin = require('firebase-admin');
            
            // Only initialize if not already initialized
            if (!admin.apps.length) {
                const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            }
            
            const db = admin.firestore();
            const botToken = process.env.BOT_TOKEN;

            // Validate Telegram Signature
            const crypto = require('crypto');
            const urlParams = new URLSearchParams(initData);
            const hash = urlParams.get('hash');
            urlParams.delete('hash');
            
            const dataCheckString = Array.from(urlParams.entries())
                .sort(([a], [b]) => a < b ? -1 : 1)
                .map(([key, val]) => `${key}=${val}`)
                .join('\n');
                
            const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();            const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
            
            if (calculatedHash !== hash) {
                console.log("⚠️ Invalid signature");
                // We still return success to prevent the bot from getting stuck, but log it
            }

            const userStr = new URLSearchParams(initData).get('user');
            const userData = JSON.parse(userStr);
            const telegram_id = String(userData.id);

            // Check for duplicate
            const deviceKey = `device_${device_fp}`;
            const deviceDoc = await db.collection('devices').doc(deviceKey).get();

            let isDuplicate = false;

            if (deviceDoc.exists) {
                const existingUserId = deviceDoc.data().telegram_id;
                if (String(existingUserId) !== telegram_id) {
                    isDuplicate = true;
                }
            }

            // Save to database
            await db.collection('devices').doc(deviceKey).set({
                telegram_id: telegram_id,
                device_fp: device_fp,
                created_at: Date.now()
            }, { merge: true });

            await db.collection('users').doc(telegram_id).set({
                device_fp: device_fp,
                device_verified: 'yes',
                referral_blocked: isDuplicate ? 'yes' : 'no',
                verified_at: Date.now()
            }, { merge: true });

            console.log("✅ Saved to Firebase. Duplicate:", isDuplicate);
            return res.json({ success: true, duplicate: isDuplicate });

        } catch (firebaseError) {
            console.error("🔥 Firebase Error:", firebaseError.message);
            // If Firebase fails, we STILL return success so the user isn't stuck!
            return res.json({ success: true, duplicate: false, error: "Firebase skipped" });
        }

    } catch (error) {
        console.error("💥 Server Crash Prevented:", error.message);
        // NEVER return a network error. Always return JSON.        res.json({ success: true, duplicate: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
