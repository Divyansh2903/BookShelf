# Serialization, Deserialization, Authentication and Authorization

<<<SECTION 1>>>
Second article in the backend series (the first covered HTTP and routing).

**Packing and unpacking data.** Like shipping a package to a friend (wrap, box, ship, unwrap), serialization and deserialization package data for transport.

### What Is Serialization?

Converting an in-memory object (Python dict, Java class instance, JavaScript object) into a storable or transmittable format: JSON, XML, or binary bytes.

```python
user = User(id=42, name="Harry", role="admin", active=True)
```

Serialized for HTTP or a file:

```json
{
  "id": 42,
  "name": "Harry",
  "role": "admin",
  "active": true
}
```

### What Is Deserialization?

The reverse: rebuilding the object in memory from the serialized format.

```python
data = json.loads(raw_json)
user = User(**data)  # Harry is back here
```

<<<SECTION 2>>>
### Now, why Does Backend Engineering care so much about this?

Backends constantly move data: API responses to apps and browsers, messages to Kafka or RabbitMQ, objects cached in Redis, records stored in databases, microservice calls via gRPC or REST. None of it works without serialization.

**Popular formats**

**1. JSON**: the web's most common format. Human-readable, language-agnostic, supported everywhere. Pros: easy to debug, universal. Cons: no schema enforcement.

```json
{ "product": "Laptop", "price": 999.99, "inStock": true }
```

**2. XML** (the veteran): older, verbose, still dominant in enterprise systems and SOAP APIs.

```xml
<product>
  <name>Laptop</name>
  <price>999.99</price>
</product>
```

**3. Protocol Buffers (Protobuf)**: Google's binary format. Define a schema (`.proto`), get compact, fast binary output. Popular in microservices. Pros: tiny payload, very fast. Cons: not human-readable, needs schema setup.

```proto
message Product {
  string name = 1;
  float price = 2;
  bool in_stock = 3;
}
```

**4. MessagePack** (binary JSON): JSON semantics in binary, a drop-in speed upgrade. Pros: faster than JSON, compact. Cons: not human-readable.

**5. Avro** (schema enforcer): Apache's format, common with Kafka and data pipelines; schema embedded or kept in a registry. Pros: schema evolution, great for streaming. Cons: more complex setup.

Serialization is invisible plumbing until it breaks: a renamed field crashes a mobile app, a binary format confuses debugging, an untrusted payload exploits a deserializer.

**Authentication and Authorization**

Like an office or college gate guard who checks your ID (who you are), then a list of floors you may visit (what you can do):
- **Authentication (AuthN)**: who are you?
- **Authorization (AuthZ)**: what are you allowed to do?

Similar-sounding, deeply different.

<<<SECTION 3>>>
### Authentication: Proving Your Identity

Verifying you are who you claim to be; saying "I'm Harry" isn't proof.

**Username + password**: send credentials; the backend checks them against a stored hashed password and grants a session or token, which you carry from then on.

```http
POST /login
{
  "email": "harry@gmail.com",
  "password": "secret123"
}
```

**Golden rule:** never store plain-text passwords. Hash with a slow algorithm: **bcrypt**, **Argon2**, or **scrypt**. MD5 and SHA1 are unacceptable because they are fast.

```python
# Hashing a password
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())

# Verifying on login
bcrypt.checkpw(entered_password.encode(), hashed)  # True or False
```

<<<SECTION 4>>>
### The Token Problem: Staying Logged In

HTTP is **stateless**, so the server needs a way to recognize you on later requests.

**Sessions (old school)**: after login, the server stores a session (in its database or a store like Redis) and sends a `session_id` cookie.
1. Login: server creates `{ id: "abc123", userId: 10 }`, sends cookie `session_id=abc123`.
2. Next request: browser sends the cookie; server looks up "abc123" → userId 10.

Easy to revoke (delete the session), but server-side state doesn't scale well across many servers.

**JWT (JSON Web Tokens, modern)**: nothing stored server-side. The server **signs a token**; the client sends it with every request; the server only verifies the signature, no database lookup.

Example: `eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjQyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`

Format `HEADER.PAYLOAD.SIGNATURE`:
- Header: `{ "alg": "HS256", "typ": "JWT" }`
- Payload: `{ "userId": 100, "role": "admin", "exp": 1735689600 }`
- Signature: `HMAC(header + payload, secret_key)`

Tampering with the payload breaks the signature. Flow: `Bearer eyJhbGci...` → verify signature → decode payload → `userId: 100`.

Pros: stateless, scalable, works well across microservices. Cons: hard to revoke before expiry (needs a blocklist); a leaked secret compromises everything.

### Multi-Factor Authentication (MFA): Trust But Verify Again

Passwords alone are weak. Factors:
- **Something you know**: password, PINs
- **Something you have**: OTP app (Microsoft Authenticator), SMS code, hardware key
- **Something you are**: fingerprint, Face ID

2FA combines any two, so a leaked password isn't enough without your phone.

<<<SECTION 5>>>
### OAuth 2.0: "Login With Google"

**OAuth 2.0** delegates authentication to a trusted third party (Google, GitHub, Apple):
1. User clicks "Login with Google".
2. Google authenticates the user.
3. Google sends your backend an authorization code.
4. Your backend exchanges it for an access token.
5. You know the user without seeing their password.

**OpenID Connect (OIDC)** sits on top of OAuth 2.0 specifically for identity.

### Authorization: What You're Allowed To Do

Deciding what a known user can access; a design problem as much as a security one.

### Role-Based Access Control (RBAC)

Most common: users get roles, roles get permissions.
- **admin**: read, write, delete anything; **editor**: read and write posts; **viewer**: read posts only.
- Harry is an editor, Dimps a viewer. Harry deleting a post → Forbidden; editing → Allowed.

Clean and easy to manage; fits most applications.

<<<SECTION 6>>>
### Attribute-Based Access Control (ABAC)

Decisions use attributes of user, resource, and environment, evaluated against policies.

```python
# Can this user access this document?
def can_access(user, document, action):
    return (
        user.department == document.department and
        user.clearance_level >= document.sensitivity and
        action in user.allowed_actions and
        current_time() within business_hours()
    )
```

Pros: very fine-grained, handles complex conditional rules. Cons: harder to reason about and audit.

### Permission-Based / ACL (Access Control Lists)

Each resource lists who can do what (like Unix file permissions or Google Docs sharing). E.g. "Q4_Report.pdf": Harry read/write, Dimps read, Public none.

Pros: precise per-resource control. Cons: unwieldy at scale (millions of resources × thousands of users).

<<<SECTION 7>>>
### How Authorization Happens in Code

Enforce at multiple layers.

**1. Middleware / route level**

```python
@app.route("/admin/users")
@require_role("admin")  # <- Gate at the door
def list_users():
    return User.query.all()
```

**2. Service / business logic level**

```python
def delete_post(requesting_user, post_id):
    post = Post.get(post_id)
    if post.author_id != requesting_user.id and not requesting_user.is_admin:
        raise PermissionError("You can't delete someone else's post")
    post.delete()
```

**3. Database / query level**

```python
# Never return data the user shouldn't see, even accidentally
posts = Post.query.filter_by(author_id=current_user.id).all()
```

Checking only at the route level causes **IDOR (Insecure Direct Object Reference)** bugs: a user guesses another user's resource ID and accesses it.

**Best practices**
- Hash passwords with bcrypt/Argon2: slow hashing defeats brute force.
- Short-lived JWTs + refresh tokens: limit damage from a stolen token.
- Authorize at the resource level: check "allowed", not just "logged in".
- Rate-limit login endpoints: stops brute force and credential stuffing.
- HTTPS everywhere: tokens over plain HTTP are trivially stolen.
- Least privilege: grant only needed permissions.
- Log auth events: failed logins, token refreshes, permission denials.

The full flow (handwritten diagram):

{{IMG:1}}

Get authentication and authorization wrong and nothing else matters: user data is exposed, the business is liable, and trust is lost.
