# FamilyCall - पूरी तरह तैयार! ✅

## ✅ APK Build Successful! (7.12 MB)

APK file: `FamilyCall.apk` (इसी folder में है)

---

## अब बस 3 काम करने हैं:

### 1️⃣ Firebase प्रोजेक्ट बनाएं (2 मिनट)
1. https://console.firebase.google.com पर जाएं
2. **Create a project** → `FamilyCall` नाम दें
3. **Android app add करें**:
   - Package name: `com.familycall.app`
   - `google-services.json` डाउनलोड करें
   - इस file को `android/app/google-services.json` में रखें
4. **Authentication** → Sign-in method → **Phone** enable करें
5. **Realtime Database** → Create Database → Rules में डालें:
```json
{
  "rules": {
    "users": { ".read": "auth != null", ".write": "auth != null" },
    "calls": { ".read": "auth != null", ".write": "auth != null" },
    "audio": { ".read": "auth != null", ".write": "auth != null" },
    "fcm_tokens": { ".read": "auth != null", ".write": "auth != null" },
    "web_subscriptions": { ".read": "auth != null", ".write": "auth != null" }
  }
}
```

### 2️⃣ Server Config करें
`server/public/js/config.js` में Firebase values डालें:
```javascript
window.FAMILYCALL_API_KEY = 'YOUR_API_KEY';
window.FAMILYCALL_AUTH_DOMAIN = 'YOUR_PROJECT.firebaseapp.com';
window.FAMILYCALL_DB_URL = 'https://YOUR_PROJECT-default-rtdb.firebaseio.com';
window.FAMILYCALL_PROJECT_ID = 'YOUR_PROJECT_ID';
```

### 3️⃣ APK Install करें
`FamilyCall.apk` सबके Android phone में डालें और install करें।

---

## दो तरीके से काम करता है:

### 📱 App-to-App (दोनों के पास app)
- Caller App se call kare → Receiver ko **real incoming call** (ring, screen on)
- Dono ke paas internet hona chahiye

### 🌐 App-to-Web (Papa के पास सिर्फ internet)
- Caller "Call via Link" kare → WhatsApp पर link bheje
- Papa link click kare → Chrome में call connect

---

## Test कैसे करें?
1. Firebase setup करें
2. Two phones mein APK install करें
3. Dono login करें (OTP)
4. Ek phone se doosre ko call करें

## कुछ और चाहिए?
Server deploy karvani hai? Firebase setup mein help chahiye? Batao!
