# Design A Notification System

<<<SECTION 1>>>
Notification systems power WhatsApp pings, Instagram likes, OTPs, and IPL score alerts, at millions of users.

### Functional requirements

1. Users subscribe to the system.
2. The system captures events (a like, a match score, an OTP trigger).
3. The system publishes notifications to subscribers.

**Channels:** push (phone pop-up), email, SMS (OTPs, alerts), in-app (bell icon with red dot). Each channel is its own service, not a monolith: they scale differently, fail independently, and have different latency needs.

### The router, not just an API gateway

A **Notification Router** between Kafka and the channel services holds business logic:

- "This user has SMS turned off -> skip SMS"
- "This is an OTP -> use SMS regardless of preferences"
- "Push failed -> fallback to email"

An API gateway routes blindly by URL; the router knows each user.

### The database layer - you need two

**User preferences DB:** which channels the user wants, which notifications they subscribed to, their device push token. Cached in Redis so the router doesn't hit the DB per notification.

<<<SECTION 2>>>
### Notification log DB

Stores every sent notification: notificationID, userID, channel, content, status (sent / delivered / failed), created_at. The tracking service writes it after each send.

**Scale: why Kafka.** When Bumrah takes an IPL wicket, 10 million users need a notification in the same second; events hitting channel services directly would collapse them. Kafka buffers the spike: events queue first and channel services consume at their own pace (like a restaurant ticket system). If a channel service goes down, messages wait in Kafka until it recovers.

**Full architecture:**
1. Subscribers → User Preferences DB
2. Event capturing service
3. Kafka (message queue)
4. Notification Router → queries User Preferences DB
5. Push / Email / SMS / In-app services (parallel)
6. Tracking service → Notification Log DB

**Tracking:** was it delivered to the device, opened (tapped), or failed (wrong token, email bounced, SMS dropped)? Failures retry with exponential backoff (1s, 2s, 4s), then fall back to another channel (**graceful degradation**). Delivery data feeds the product team (open rates, best send times, notification fatigue), and since SMS and email cost money per send, every send is tracked.

### Non-functional requirements

**Scalability:** Channel services scale horizontally and independently; an SMS spike doesn't affect push. Kafka spreads load across consumers in each consumer group.

**Latency:** Async Kafka adds slight delay, fine for most notifications. The main win is Redis-cached preferences so the router never hits the DB cold. OTPs need near-instant delivery, so they bypass Kafka and go straight to the SMS service.

**Availability:**
1. Kafka replication across brokers; losing one broker loses no messages.
2. Automatic retry with exponential backoff.
3. Fallback channels: push → email → SMS, degrading gracefully instead of dropping the notification.
