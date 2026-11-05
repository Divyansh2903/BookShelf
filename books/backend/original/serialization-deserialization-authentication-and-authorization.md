# Serialization, Deserialization, Authentication and Authorization

<<<SECTION 1>>>
Welcome to the 2nd article of this backend series, folks!  
In the 1st article, we talked about HTTP & routing-related stuff. Now, we're gonna learn about some more interesting & important features of backend engineering.

The Art of Packing and Unpacking Data

Imagine you want to send an item to your friend in another city. You can't just teleport it, right? You need to wrap it up, put it in a box, ship it, and then your friend unwraps it on the other side. That's exactly what serialization and deserialization do, but for data.

### What Is Serialization?

It is the process of converting an in-memory object (a Python dict, a Java class instance, a JavaScript object) into a format that can be stored or transmitted (For eg: JSON, XML, or binary bytes).

Your backend has a User object living in memory:  
python (for eg)

user = User(id=42, name="Harry", role="admin", active=True)

To send this over HTTP or save it to a file, you *serialize* it:

json

{  
  "id": 42,  
  "name": "Harry",  
  "role": "admin",  
  "active": true  
}

The rich, complex object becomes a flat, portable string. It has been "packed for the journey".

### What Is Deserialization?

Deserialization is the reverse of what we just learned, bois & grills. Taking that flat, serialized format and reconstructing the original object back in memory.

Your friend's server receives the JSON string and goes:

python

data = json.loads(raw_json)  
user = User(\*\*data)  Harry is back here

The string comes back to life as a fully usable object. It's been unpacked and reassembled.

<<<SECTION 2>>>
### Now, why Does Backend Engineering care so much about this?

Because backends are obsessed with moving data around. Every single day, your systems are:

- Sending API responses to mobile apps and browsers
- Publishing messages to queues like Kafka or RabbitMQ
- Caching objects in Redis
- Storing records in databases
- Communicating between microservices via gRPC or REST

None of that works without serialization.

The Popular Formats

1. JSON : The most widely used format on the web. Human-readable, language-agnostic, and supported everywhere.

json

{ "product": "Laptop", "price": 999.99, "inStock": true }

Pros:  
Easy to debug      
Universal support     
  
Cons:  
No schema enforcement

2. XML : The Veteran

Older, more verbose, but still king in enterprise systems and SOAP APIs.

xml

<product>  
  <name>Laptop</name>  
  <price>999.99</price>  
</product>

3. Protocol Buffers (Protobuf) : The Quicksilver here (Sorry)

Google's binary format. You define a schema (.proto file), and it generates compact, fast binary output. Beloved in microservice architectures.

proto

message Product {  
  string name = 1;  
  float price = 2;  
  bool in_stock = 3;  
}

Pros  
Tiny payload size     
Blazing fast     
  
Cons  
Not human-readable     
Requires schema setup

4. MessagePack: The Binary JSON

Like JSON, but encoded in binary. Drop-in speed upgrade for systems that already use JSON semantics.

Pros   
Faster than JSON     
Compact     
  
Cons  
Not human-readable

5.  Avro : The Schema Enforcer

Apache's format, heavily used in the Kafka/data pipeline world. Schema is embedded or stored in a registry.

Pros   
Schema evolution support     
Great for streaming      
  
Cons  
More complex setup

P.S - Serialization and deserialization are the invisible plumbing of every backend system. They're so fundamental that most developers take them for granted, until something breaks. A renamed field crashes a mobile app. A binary format confuses a debugging session. An untrusted payload exploits a deserializer.  
  
**Authentication and Authorization**  
  
Basically - "Who Are You?" vs "What Can You Do?"

Imagine you arrive at a fancy corporate office (or at your college's gate). The security guard at the front desk checks your ID card. That's him figuring out *who you are*. Then he checks a list to see which floors you're allowed to visit. That's him deciding what you can do.

That two-step process happens in every backend system, billions of times a day. It has a name:

**Authentication (AuthN)** means Who are you?

**Authorization (AuthZ)** means What are you allowed to do?

They sound similar. They are deeply different.

<<<SECTION 3>>>
### Authentication: Proving Your Identity

Authentication is the process of verifying that you are who you claim to be. The backend doesn't trust you just because you say "I'm Harry." It needs proof.

The Classic: Username + Password

The oldest trick in the book. You send credentials, the backend checks them against a stored (hashed) password, and grants you a session or token.

http

POST /login  
{  
  "email": "harry@gmail.com",  
  "password": "secret123"  
}

The server responds with proof of identity i.e. a token you carry from here on.

**There is a golden Rule:** Never store passwords in plain text. Always hash with a slow algorithm like **bcrypt**, **Argon2**, or **scrypt**. MD5 and SHA1 are not acceptable. They're fast, and fast is bad for password hashing.

Python

(Hashing a password)  
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())  
  
(Verifying on login)  
bcrypt.checkpw(entered_password.encode(), hashed)  - True or False

<<<SECTION 4>>>
### The Token Problem: Staying Logged In

HTTP is **stateless.** The server remembers nothing between requests. So after login, how does the server know it's still you on the next request?

Two classic answers:

Sessions (The Old School Way)

After login, the server creates a session record in its database or memory store (like Redis), and sends you a session_id cookie.

Login -> Server creates Session { id: "abc123", userId: 10 }  
       -> Sends cookie: session_id=abc123  
  
Next Request -> Browser sends cookie automatically  
             -> Server looks up "abc123" -> finds userId 10 -> Goodie!

It is easy to revoke (just delete the session) but the server must store state, so it doesn't scale beautifully across many servers

JWT - JSON Web Tokens (The Modern Way)

Instead of storing anything server-side, the server **signs a token** and gives it to the client. The client sends it back with every request. The server just verifies the signature. No database lookup needed.

A JWT looks like this:

eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjQyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c

Three parts, separated by dots:

HEADER.PAYLOAD.SIGNATURE  
  
Header  → { "alg": "HS256", "typ": "JWT" }  
Payload → { "userId": 100, "role": "admin", "exp": 1735689600 }  
Signature → HMAC(header + payload, secret_key)

The server signs the token with a secret. If anyone tampers with the payload, the signature breaks. Forgery detected.

Request -> Bearer eyJhbGci...  
Server  -> Verifies signature -> Decodes payload -> userId: 100

Stateless and scalable   
Works great across microservices   
  
But it is hard to revoke before expiry (need a blocklist for that). If the secret leaks, everything is compromised

### Multi-Factor Authentication (MFA): Trust But Verify Again

Passwords alone are weak. MFA adds extra proof layers:

**Something you know:** Password, PIN**S**  
**Something you have:** OTP app (Microsoft Authenticator), SMS code, hardware key  
**Something you are:** Fingerprint, Face ID

Two-factor authentication (2FA) combines any two. Even if your password leaks, an attacker still can't log in without your phone.

<<<SECTION 5>>>
### OAuth 2.0: "Login With Google"

Sometimes you don't want to handle authentication yourself at all. **OAuth 2.0** lets your users authenticate via a trusted third party — Google, GitHub, Apple — and your backend receives a token confirming who they are.

User clicks "Login with Google"  
Google authenticates the user  
Google sends your backend an authorization code  
Your backend exchanges it for an access token  
You know who the user is without ever seeing their password

You're not the one doing authentication, you're delegating i**t** to Google. This is the core idea of OAuth 2.0 and OpenID Connect (OIDC), which sits on top of it specifically for identity.

### Authorization: What You're Allowed To Do

Once the system knows who you are, it must decide what you can access. This is authorization, and it's a design problem as much as a security one.

### Role-Based Access Control (RBAC)

The most common model. Users are assigned roles, and roles have permissions.

Roles:  
  admin  : can read, write, delete anything  
  editor  : can read and write posts  
  viewer  : can only read posts  
  
User Harry -> role: editor  
User Dimps -> role: viewer  
  
Harry tries to delete a post ->  Forbidden  
Harry tries to edit a post  -> Allowed

Clean, easy to reason about, easy to manage. Works great for most applications.

<<<SECTION 6>>>
### Attribute-Based Access Control (ABAC)

More powerful and flexible. Access decisions are based on attributes of the user, the resource, and the environment, evaluated against policies.

python

# Can this user access this document?  
def can_access(user, document, action):  
    return (  
        user.department == document.department and  
        user.clearance_level >= document.sensitivity and  
        action in user.allowed_actions and  
        current_time() within business_hours()  
    )

Extremely fine-grained + Handles complex, conditional rules   
But harder to reason about and audit

### Permission-Based / ACL (Access Control Lists)

Instead of roles, each resource carries a list of who can do what to it, like Unix file permissions or Google Docs sharing settings.

Document "Q4_Report.pdf":  
  Harry  - read, write  
  Dimps  - read  
  Public - no access

Very precise per-resource control   
But gets unwieldy at scale (millions of resources × thousands of users)

<<<SECTION 7>>>
### How Authorization Happens in Code

In practice, authorization checks are enforced at multiple layers:

1. Middleware / Route Level

python

[@app](https://x.com/@app).route("/admin/users")  
[@require_role](https://x.com/@require_role)("admin")  # <- Gate at the door  
def list_users():  
    return User.query.all()

2. Service / Business Logic Level

python

def delete_post(requesting_user, post_id):  
    post = Post.get(post_id)  
    if [post.author](https://x.com//post.author)_id != requesting_user.id and not requesting_user.is_admin:  
        raise PermissionError("You can't delete someone else's post")  
    post.delete()

3. Database / Query Level

python

# Never return data the user shouldn't see, even accidentally  
posts = Post.query.filter_by(author_id=current_user.id).all()

Checking only at the route level and trusting the rest is a classic mistake that leads to Insecure Direct Object Reference (IDOR) bugs, where a user guesses another user's resource ID and accesses it freely.

Best Practices at a Glance

**Hash passwords with bcrypt/Argon2:** Slow hashing defeats brute-force attacks  
**Use short-lived JWTs + refresh tokens:** Limits damage if a token is stolen  
**Always authorize at the resource level:** Don't just check if logged in. Check if allowed  
**Rate-limit login endpoints:** Prevents brute-force and credential stuffing  
**Use HTTPS everywhere:** Tokens in plaintext HTTP are trivially stolen  
**Principle of Least Privilege:** Give users only the permissions they actually need  
**Log auth events:** Failed logins, token refresh, permission denials - all audit-worthy

The Full Picture in One Flow (ignore my handwriting)

{{IMG:1}}

Authentication and authorization are the gatekeepers of your entire system. Get them wrong, and it doesn't matter how elegant your database schema is or how fast your API is.. your users' data is exposed, your business is liable, and trust is gone.

That's all, folks !!
