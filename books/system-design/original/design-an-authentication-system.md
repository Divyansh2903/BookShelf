# Design an Authentication System

<<<SECTION 1>>>
Authentication is how your system verifies who a user is. Authorization is what they're allowed to do. This design covers the full authentication stack-registration, login, session management, token refresh, OTP, and OAuth... and how to build it securely at scale.

### Functional requirements

1. Register -> save credentials securely   
2. Login -> verify credentials, issue tokens   
3. Session mgmt -> keep user logged in via tokens   
4. Token refresh -> renew session without re-login   
5. Forgot passwd -> OTP verification, reset credentials   
6. Logout -> invalidate session

### Password storage: hashing and salting

Passwords are never stored as plain text. If your DB is compromised and an attacker sees "password123" directly, yeah that's game over. The fix is hashing.

But hashing alone has a vulnerability. If two users share the same password, they produce the same hash. A hacker with a rainbow table (precomputed list of common password hashes) can instantly reverse engineer them.

Salting fixes this. A unique random string is generated per user and appended to the password before hashing:

password = "password123" salt = "xK92p" (unique per user, random) stored_hash = bcrypt("password123" + "xK92p") User 1: bcrypt("password123" + "xK92p") = "a3f9c2..." User 2: bcrypt("password123" + "m7n1q") = "z8p4r1..."

Same password, completely different hashes. Rainbow tables useless. The salt is stored alongside the hash. It's not secret, it just makes every hash unique. Use bcrypt or Argon2. Both have salting built in and are intentionally slow to compute, making brute force attacks impractical.

<<<SECTION 2>>>
### JWT - JSON Web Token

After login, the server issues a JWT so the user doesn't send their password on every request. A JWT has three parts:

header.payload.signature header -> algorithm (HS256)   
payload -> { userID: "123", role: "admin", exp: 1714000000 }   
signature -> hash(header + payload + secret_key) proves token hasn't been tampered with

JWT is stateless i.e. the server stores nothing. Every request carries the token, the server verifies the signature mathematically, and reads the payload. Zero DB lookup. Sub-millisecond verification on every request.

### The refresh token pattern

JWT has one weakness. Once issued, it's valid until expiry. A stolen token can't be invalidated. Short expiry (15 minutes) limits damage but logs users out constantly. The fix is two tokens:

Login -> issue two tokens: Access Token -> JWT, expires in 15 minutes stateless, verified by signature NOT stored in DB Refresh Token -> opaque random string, 30 days stored in DB + Redis cache   
Every request uses Access Token (fast, no DB hit) Access Token expires: -> client sends Refresh Token -> server validates against DB -> issues new Access Token    
Logout: -> delete Refresh Token from DB -> stolen Access Token expires in max 15 min -> Refresh Token dead -> can't renew

Best of both worlds : short-lived access tokens for security, refresh tokens for good UX.

### OTP - forgot password flow

User enters email -> generate 6-digit OTP -> store hashed OTP in OTP table with 10 min TTL -> send via Notification Service (SMS or email) User submits OTP: -> verify hash -> valid + not expired -> allow password reset Invalid ?-> increment attempts -> 3 failed attempts -> block, force resend

OTP is always stored hashed, never plain text. Attempting to limit prevents brute force (there are only 1M possible 6-digit OTPs).

<<<SECTION 3>>>
### OAuth 2.0 - Login with Google

OAuth lets your app delegate authentication to a trusted provider - Google, GitHub, Apple. Four players: the user, your app, the Auth Server (Google), and the Resource Server (Google's API).

User clicks "Login with Google" -> your app redirects to Google Auth Server -> Google asks user for permission -> user approves -> Google issues Authorization Code to your app -> your app exchanges code + secret key for Access Token -> fetch user profile (name, email, picture) -> user is logged in

The Authorization Code step exists because the redirect happens in the browser, so it's visible to anyone. The code is useless without your app's secret key, so interception is harmless. OAuth handles the "who vouches for this user" question. JWT handles the token format. They work together.

### The data layer

Three DB tables and one cache

Users table (PostgreSQL) -  userID, email, password_hash, salt, role, created_at. Queried only on registration and login. Never stores plain passwords or tokens.

Refresh Token table (PostgreSQL) - tokenID, userID, refresh_token, expires_at, device_info, created_at. One row per active session. Deleted on logout.

OTP table (PostgreSQL) - otpID, userID, otp_hash, expires_at, attempts, created_at. Short-lived rows, auto-deleted after expiry.

Redis cache - refresh token lookups (faster than DB), user session data (role, email), failed login attempt counters for rate limiting.

Access Tokens are never stored anywhere. JWT is self-verifying. That's the point.

### Non-functional requirements

### Latency

JWT verification on every request is pure math. No DB, no cache, sub-millisecond. Refresh token lookups hit Redis first. Login is the only flow that touches PostgreSQL, and it happens rarely relative to request volume.

### Scalability

Stateless JWT means any Auth Service instance can verify any token. No shared session state between servers. Scale horizontally with zero coordination overhead. Redis handles the small amount of shared state (refresh tokens, rate limiting counters).

### Security

Passwords hashed with bcrypt + unique salt. Access Tokens short-lived (15 min). Refresh Tokens stored hashed in DB. OTPs hashed, time-limited, attempt-limited. Rate limiting on login attempts via Redis counters. OAuth delegates password responsibility to trusted providers entirely.  
  
  
That's all folks!
