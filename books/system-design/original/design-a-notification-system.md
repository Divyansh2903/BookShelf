# Design A Notification System

<<<SECTION 1>>>
Notification systems power every app you use like WhatsApp pings, Instagram likes, OTPs, IPL score alerts. Let's break down the design that scales to millions of users.

### Functional requirements

Three things:

1. Users can subscribe to the system  
2. The system captures events (a like, a match score, an OTP trigger)  
3. The system publishes notifications to subscribers

**Notification channels**  
A notification can reach a user through four channels:  
1. Push notification - the pop-up on your phone screen  
2. Email - lands in your inbox  
3. SMS - text message, used for OTPs and alerts  
4. In-app notification - the bell icon with a red dot

Each channel gets its own service. They don't belong in one monolith. They scale differently, fail independently, and have different latency requirements.

### The router, not just an API gateway

Between Kafka and the channel services sits a Notification Router. It looks similar to an API gateway but has actual business logic baked in:

"This user has SMS turned off -> skip SMS"

"This is an OTP -> use SMS regardless of preferences"

"Push failed -> fallback to email"

An API gateway routes blindly by URL. The router knows each user personally.

### The database layer - you need two

### User preferences DB

Before sending anything, the router needs to know: what channels does this user want? What notifications have they subscribed to? What's their device push token? This DB answers all of that. Cache it in Redis so the router isn't hitting the DB on every single notification.

<<<SECTION 2>>>
### Notification log DB

Every notification that goes out gets stored here - notificationID, userID, channel, content, status (sent / delivered / failed), and created_at. The tracking service writes to this after every send.

The scale problem, and why Kafka solves it

Imagine it's IPL season & Bumrah takes a wicket. 10 million users need a notification in the same second. If events hit the channel services directly, they collapse.

The fix is a message queue - Kafka. Events go into the queue first. Channel services consume from it at their own pace. The queue acts as a buffer between the spike and your services.

Think of it like a restaurant. Without a queue, 100 customers walking in at once collapses the kitchen. With a ticket system, the kitchen processes orders steadily at full speed.

Kafka also means: if a channel service goes down, messages aren't lost. They stay in Kafka until the service recovers.

The full architecture

Subscribers → User Preferences DB

↓

Event capturing service

↓

Kafka (message queue)

↓

Notification Router → queries User Preferences DB

↓

Push / Email / SMS / In-app services (parallel)

↓

Tracking service → Notification Log DB

Post-delivery - tracking

Once a notification is sent, you want to know three things:

1. Was it delivered? Did it reach the device?  
2. Was it opened? Did the user tap it?  
3. Did it fail? Wrong token, email bounced, SMS dropped?

Failed notifications trigger retry logic with exponential backoff - retry after 1s, then 2s, then 4s. If all retries fail, fall back to another channel. This is called graceful degradation.

Delivery data also feeds the product team - open rates, best send times, notification fatigue signals. And for SMS and email, every send costs money, so you track every one.

### Non-functional requirements

### Scalability

Each channel service scales horizontally and independently. An SMS spike doesn't affect your push notification service. Kafka distributes load naturally across multiple consumers in each consumer group.

### Latency

Kafka is async, so it introduces a slight delay, which is fine for most notifications. The real latency win comes from caching user preferences in Redis so the router never hits the DB cold.

P.S - OTPs are the exception. They need near-instant delivery, so they bypass Kafka entirely and go directly to the SMS service.

### Availability

Three layers of protection:

1. Kafka replication - messages are copied across multiple brokers. One broker goes down, no messages are lost.

2. Retry with exponential backoff, failed sends are retried automatically.

3. Fallback channels, push fails? Try email. Email fails? Try SMS. The system degrades gracefully instead of dropping the notification entirely.

That's mostly it, legends! Thanks for reading it!
