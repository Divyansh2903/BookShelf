# Design an Authentication System

<<<SECTION 1>>>
**Authentication** verifies who a user is; **authorization** is what they may do. Covers registration, login, sessions, token refresh, OTP, and OAuth, secure at scale.

### Functional requirements

1. Register: save credentials securely
2. Login: verify, issue tokens
3. Sessions: stay logged in via tokens
4. Token refresh: renew without re-login
5. Forgot password: OTP, reset credentials
6. Logout: invalidate session

### Password storage: hashing and salting

Never store plain-text passwords; hash them. But identical passwords give identical hashes, reversible via a **rainbow table** (precomputed common-password hashes).

**Salting:** append a unique random per-user string before hashing:

password = "password123" salt = "xK92p" (unique per user, random) stored_hash = bcrypt("password123" + "xK92p") User 1: bcrypt("password123" + "xK92p") = "a3f9c2..." User 2: bcrypt("password123" + "m7n1q") = "z8p4r1..."

Same password, different hashes. The salt is stored with the hash; it isn't secret. Use **bcrypt** or **Argon2**: salting built in, intentionally slow, so brute force is impractical.

<<<SECTION 2>>>
### JWT - JSON Web Token

Issued after login so the password isn't sent per request. Format `header.payload.signature`:
- header: algorithm (HS256)
- payload: { userID: "123", role: "admin", exp: 1714000000 }
- signature: hash(header + payload + secret_key), proves no tampering

Stateless: server stores nothing, verifies the signature mathematically. No DB lookup; sub-millisecond.

### The refresh token pattern

A JWT is valid until expiry, so a stolen one can't be revoked. A 15-minute expiry limits damage but logs users out constantly. Use two tokens:

- **Access Token:** JWT, 15 min, verified by signature, NOT stored in DB. Used on every request (no DB hit).
- **Refresh Token:** opaque random string, 30 days, stored in DB + Redis.
- On access expiry: client sends Refresh Token, server validates against DB, issues new Access Token.
- **Logout:** delete Refresh Token; a stolen Access Token dies within 15 min and can't be renewed.

### OTP - forgot password flow

1. Email entered: generate 6-digit OTP, store its hash in OTP table (10 min TTL), send via Notification Service (SMS/email).
2. OTP submitted: verify hash; if valid and unexpired, allow reset.
3. Invalid: increment attempts; 3 failures block and force resend.

OTPs are stored hashed. Attempt limits stop brute force (only 1M 6-digit OTPs).

<<<SECTION 3>>>
### OAuth 2.0 - Login with Google

Delegates authentication to a provider (Google, GitHub, Apple). Players: user, your app, Auth Server (Google), Resource Server (Google's API).

**Flow:** "Login with Google" -> redirect to Google Auth Server -> user grants permission -> Google issues Authorization Code -> app exchanges code + secret key for Access Token -> fetch profile (name, email, picture) -> logged in.

The code step exists because the browser redirect is visible; the code is useless without the app's secret, so interception is harmless. OAuth says who vouches for the user; JWT is the token format.

### The data layer

- **Users** (PostgreSQL): userID, email, password_hash, salt, role, created_at. Used only at registration/login; no plain passwords or tokens.
- **Refresh Token** (PostgreSQL): tokenID, userID, refresh_token, expires_at, device_info, created_at. One row per session; deleted on logout.
- **OTP** (PostgreSQL): otpID, userID, otp_hash, expires_at, attempts, created_at. Auto-deleted after expiry.
- **Redis:** refresh token lookups, session data (role, email), failed-login counters for rate limiting.

Access Tokens are never stored; JWT is self-verifying.

### Non-functional requirements

- **Latency:** JWT checks are pure math, sub-millisecond. Refresh lookups hit Redis first. Only the rare login touches PostgreSQL.
- **Scalability:** any Auth Service instance verifies any token; no shared session state, so horizontal scaling needs no coordination. Redis holds the small shared state.
- **Security:** bcrypt + unique salt; 15-min Access Tokens; Refresh Tokens hashed in DB; OTPs hashed, time- and attempt-limited; Redis login rate limiting; OAuth offloads passwords to providers.
