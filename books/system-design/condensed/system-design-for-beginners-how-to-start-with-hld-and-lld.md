# System Design for Beginners: How to Start With HLD and LLD

<<<SECTION 1>>>
## Introduction

Many system design resources jump into diagrams of load balancers, queues, and databases without explaining why they matter or where to begin. This guide assumes no prior knowledge. It covers what High Level Design (HLD) and Low Level Design (LLD) mean, how they differ, the concepts each needs, and how to practice both. It is a map, not a shortcut: where to start, what to learn next, and why each piece matters.

## What System Design Actually Is

System design is deciding how a software system is structured so it works correctly, handles expected load, and can grow without falling apart. In an app like Instagram, with millions uploading, scrolling, and messaging every second, someone deliberately decided how data moves, where it is stored, how it is retrieved quickly, and what happens when parts fail.

System design splits into two categories.

### High Level Design (HLD)

The big picture. It answers:

- What the major components are
- How they talk to each other
- Where data is stored, and why
- How the system handles millions of users instead of a few
- What happens when something breaks

Designing Twitter at a high level means thinking about how tweets are stored, how feeds are generated for millions, and how the system stays fast under load, not class structures or functions.

### Low Level Design (LLD)

The detailed, code-level view. It answers:

- What classes and objects should exist
- How they interact
- Which design patterns make the code flexible and maintainable
- How to structure code so it extends without breaking

If HLD is a building's blueprint, LLD is the plan for how each room is wired, plumbed, and finished. A great blueprint with poor wiring fails, and so does strong architecture with messy, unmaintainable code.

<<<SECTION 2>>>
## Why Beginners Should Learn Both

Beginners often pick one: HLD for its buzzwords (Kafka, Redis, Cassandra), or LLD because it feels closer to coding. Real systems need both: good architecture with poorly structured code is painful to maintain, and clean code on a broken architecture won't scale. They are two halves of one skill.

## HLD Fundamentals, Fully Expanded

### How a Request Actually Reaches a Server

Almost every HLD concept builds on this flow.

A **server** is a machine, physical or virtual, that runs application code and waits for requests. When you type [www.example.com](http://www.example.com/), your computer first asks a **DNS** (Domain Name System) server, the internet's phone book, to translate [example.com](https://x.com//example.com) into an IP address such as 142.250.196.14.

The browser then sends the request to that IP. Because a server runs many programs, the request also specifies a **port** naming the application: 443 for secure web traffic, 80 for regular web traffic. The server processes the request and responds the same way.

This round trip is what system design optimizes. Caching, load balancing, and CDNs all exist to make this loop faster, more reliable, or able to survive more traffic.

Real world example: a Google search resolves [google.com](https://x.com//google.com) via DNS, sends the request to that IP on port 443, Google's search infrastructure processes the query, and the browser renders the response as the results page.

<<<SECTION 3>>>
### Latency and Throughput

**Latency** is the time for a single request to complete, usually in milliseconds. A page updating 200 ms after a click has 200 ms latency; lower means more responsive.

**Throughput** is how many requests a system handles per unit time, usually requests per second. A server that handles 5000 requests per second before struggling has that throughput.

Highway analogy: latency is how long one car takes to cross; throughput is how many cars pass per hour. A one-lane highway can have low latency per car but low throughput. Ideally you want both.

Real world example: a stock trading platform cares most about latency, since a 50 ms delay in a trade can cost money. A bulk email service cares about throughput: millions of emails over a few hours, where a slightly slower individual email doesn't matter.

<<<SECTION 4>>>
### Scaling and Its Types

When the existing setup can't keep up with users, the system must scale.

**Vertical scaling** makes the existing server more powerful: more CPU, RAM, or faster storage. Simple, since application logic doesn't change, but it has a ceiling: there is a physical and financial limit to one machine.

**Horizontal scaling** adds more servers and spreads traffic across them. It scales much further but adds complexity: servers need a way to share load, which is where load balancers come in.

Default to thinking horizontally for large systems; platforms like Instagram and Amazon run on horizontally scaled fleets, not one giant machine.

Real world example: a SaaS startup with a few hundred users can run on one reasonably powerful server, scaling vertically. At millions of users, as with Slack or Notion, one server can't scale further, forcing horizontal scaling.

<<<SECTION 5>>>
### Auto Scaling

Traffic isn't constant: a food delivery app is busier at lunch and dinner than at 4 a.m. Provisioning for peak at all times means paying for idle capacity.

**Auto scaling** adds or removes servers based on real-time demand. If CPU usage crosses a threshold, say 80 percent, new servers spin up and receive traffic; when traffic drops, extras shut down to save cost. Cloud platforms like AWS, GCP, and Azure let you configure these rules once and handle scaling without manual monitoring.

Real world example: BookMyShow or Ticketmaster see huge spikes when popular concert tickets go on sale, then near silence. Auto scaling adds servers only for the sale window instead of paying for peak capacity all year.

<<<SECTION 6>>>
### Back of the Envelope Estimation

Before designing (especially in interviews), roughly estimate scale. Precision isn't the goal; order of magnitude is.

A photo sharing app with 50 million daily active users each uploading 2 photos a day gets about 100 million uploads/day. At 3 MB each, that is ~300 TB of new storage daily, which makes storing photos in a regular database obviously wrong and points to dedicated object storage. The math forces you to confront real scale early so decisions are grounded in reality.

Full worked numbers for the same app:

### Given:

- 50 million daily active users
- 2 photo uploads per user per day
- 100 photo views per user per day
- Average photo size 3 MB
- 10 percent of photos also get a comment

### Step 1, Calculate Daily Writes

Uploads/day = 50,000,000 x 2 = 100,000,000

### Step 2, Calculate Daily Reads

Views/day = 50,000,000 x 100 = 5,000,000,000

Reads outnumber writes 50 to 1, so caching and read replicas matter far more than write optimization.

### Step 3, Calculate Storage Needed Per Day

100,000,000 x 3 MB = 300,000,000 MB = 300 TB per day

### Step 4, Calculate Storage Needed Per Year

300 TB x 365 ≈ 109,500 TB ≈ 109.5 PB per year

### Step 5, Calculate Requests Per Second

- Uploads/sec = 100,000,000 / 86,400 seconds ≈ 1,157
- Views/sec = 5,000,000,000 / 86,400 ≈ 57,870

### What this tells us:

A single database server is ruled out for both storage and request volume. The read/write gap calls for heavy caching and CDN delivery of photos; the storage volume puts photos in object storage like S3, not a traditional database. Back of envelope math turns vague scale into concrete architectural decisions.

<<<SECTION 7>>>
### Load Balancers, In Depth

With multiple servers, a **load balancer** in front of the fleet decides which server handles each request. Common strategies:

**Round robin** cycles through servers in order (1, 2, 3, back to 1). Simple; works when servers have similar capacity.

```
servers = [server1, server2, server3]
currentIndex = 0

function getNextServer():
    server = servers[currentIndex]
    currentIndex = (currentIndex + 1) % length(servers)
    return server
```

**Least connections** sends each request to the server with the fewest active connections. Better than round robin when some requests take much longer, since it avoids piling work onto a server busy with long-running requests.

```
servers = [server1, server2, server3]
activeConnections = { server1: 4, server2: 1, server3: 7 }

function getNextServer():
    return server with minimum value in activeConnections

    // after routing a request to that server:
    activeConnections[chosenServer] += 1

    // once that request finishes:
    activeConnections[chosenServer] -= 1
```

**IP hashing** derives a value from the client's IP and always sends that client to the same server. Needed when a server temporarily holds session-specific data and the user's requests must keep landing on the same machine.

Example: during a big promotional sale on a food delivery platform, the load balancer spreads the spike across dozens of parallel servers instead of letting one crash, keeping the app responsive.

Real world example: Amazon's Elastic Load Balancer sits in front of thousands of servers on Black Friday so no checkout server is overwhelmed while others sit idle.

<<<SECTION 8>>>
### Databases, SQL vs NoSQL

Choosing a database is one of the most consequential decisions, usually between two categories.

**Relational databases** (PostgreSQL, MySQL) organize data into structured tables with predefined columns and strict relationships. They enforce **ACID** properties, guaranteeing reliable transactions even if something fails midway. Best where correctness matters more than raw write speed, e.g. bank balances or ecommerce order history.

**NoSQL databases** (MongoDB, Cassandra, DynamoDB) trade strict structure and consistency for flexibility and massive write throughput. No fixed schema: records can have different fields without redefining a table. Best for high-volume, loosely structured data like social feeds, chat messages, or sensor data from millions of devices.

## When to Use Which Database

The skill is knowing which fits a situation, decided by a few questions about your data.

<<<SECTION 9>>>
### Ask: Does my data have complex relationships?

Multiple related entities that must be joined (users, orders, products, payments in ecommerce) → relational. SQL handles joins efficiently and keeps related data consistent via foreign keys and constraints.

Mostly self-contained data (e.g. a user profile document rarely joined to other tables) → a NoSQL document database like MongoDB fits more naturally.

### Ask: Do I need strict consistency, or can I tolerate eventual consistency?

If stale data could cause real harm (wrong account balance, double charging), you need strong consistency: a relational database with ACID guarantees.

If slight staleness is harmless (a like count or follower count briefly lagging), NoSQL's relaxed consistency is an acceptable trade for performance and scalability.

<<<SECTION 10>>>
### Ask: What does my read and write pattern look like?

Read heavy, with the same data queried repeatedly in complex ways (e.g. financial reports) → SQL, with strong indexing and query optimization.

Write heavy, with huge constant inserts (e.g. millions of location pings from delivery drivers every few seconds) → NoSQL like Cassandra, built to absorb that write load.

### Ask: How much will my schema change over time?

Structure known in advance and stable (a banking system's account and transaction tables) → a fixed SQL schema gives safety and predictability.

Evolving structure or records with differing fields (a product catalog where some products have five attributes and others twenty) → flexible-schema NoSQL avoids painful migrations.

<<<SECTION 11>>>
### Ask: How large does this need to scale?

If the system will stay within one well-provisioned server, even with some vertical scaling, SQL is an excellent, simpler choice.

If data can't fit or be processed efficiently on one machine (e.g. a social platform with billions of posts), NoSQL is generally designed for horizontal scaling across many machines.

**Quick reference (situation → better fit)**

- Banking transactions, account balances - SQL
- Ecommerce orders and payments - SQL
- User profiles with flexible fields - NoSQL
- Social media posts, likes, comments - NoSQL
- Real time location tracking - NoSQL
- Complex reporting with many joins - SQL
- Product catalog with varying attributes - NoSQL
- Inventory management with strict accuracy - SQL
- Chat messages at massive scale - NoSQL
- Financial audit logs - SQL

<<<SECTION 12>>>
### A Common Real World Pattern: Using Both Together

Most large systems use SQL and NoSQL side by side, each where it fits best.

In a ride sharing app, user accounts, driver verification, and payment records (where correctness matters) live in a relational database. Live driver location updates, constant and not needing relational structure, go to a NoSQL store or in-memory system built for high write throughput. Search may use a specialized system like Elasticsearch, since neither SQL nor typical NoSQL is optimized for fast, flexible text search.

Choosing a database is not one decision for the whole system; it is made separately for each part, based on what that data needs.

<<<SECTION 13>>>
### Scaling a Database

A single database server eventually bottlenecks. Techniques, in rough order of progression:

**Indexing** - the first, simplest step. Without an index, the database scans every row, slow at millions of rows. An index is a separate sorted structure on a column that lets the database jump almost directly to matching rows. Trade-off: extra storage and slightly slower writes, since the index must be updated on changes.

**Partitioning** - splitting one large table into smaller tables on the same server, e.g. a 500-million-row users table split by user ID ranges. Each table and its index stay smaller and faster.

**Master-slave (leader-follower) replication** - when one server can't handle read traffic. The master handles all writes; data is copied to replicas (slaves) that serve reads. Since most apps read far more than they write, adding replicas scales reads.

**Multi-master** - more than one server accepts writes, common for multi-region users (e.g. one master for Asia, one for Europe, syncing periodically). The hard part is conflict handling when the same record is updated differently on both masters before sync.

**Sharding** - the most complex technique, generally a last resort. Data is split across entirely different database servers (shards), not just tables. A social platform might shard users by user ID range, each range on a different physical server. This scales almost infinitely, beyond one machine's capacity, but cross-shard joins become expensive and complicated.

Real world example: Instagram sharded its PostgreSQL database early, splitting user data across servers by user ID instead of scaling one massive server vertically.

<<<SECTION 14>>>
### Caching, In Depth

**Caching** stores frequently requested data somewhere fast, usually in memory with Redis or Memcached, so repeat requests skip the database.

A news homepage loaded thousands of times a minute but rarely changing is cached once rendered; subsequent visitors get the cached version almost instantly instead of a database rebuild.

**Cache layers:**
- **Client side** - on the user's device, e.g. the browser caching a site's images.
- **Server side** - a fast shared layer like Redis that all application servers read.
- **CDN** - copies of content stored geographically closer to users (next section).

The hard part is **cache invalidation**: knowing when to update or remove data. If a product's price changes but the old price stays cached, users see outdated info. Approaches:
- A **TTL** (time to live), e.g. 10 minutes, after which data expires and refreshes.
- Updating the cache immediately whenever the underlying data changes, so they never fall out of sync.

Real world example: a live cricket or sports score read by millions but updated occasionally can be cached in Redis for a few seconds at a time, massively cutting database load versus querying on every refresh.

A simplified Node.js example of checking Redis before the database:

```javascript
const express = require('express');
const redis = require('redis');
const app = express();
const client = redis.createClient();

app.get('/photo/:id', async (req, res) => {
    const photoId = req.params.id;
    const cacheKey = `photo:${photoId}`;

    // Step 1: check the cache first
    const cachedPhoto = await client.get(cacheKey);
    if (cachedPhoto) {
        console.log('Cache hit');
        return res.json(JSON.parse(cachedPhoto));
    }

    // Step 2: cache miss, fetch from database
    console.log('Cache miss, querying database');
    const photo = await database.getPhotoById(photoId);

    // Step 3: store in cache for next time, expire after 1 hour
    await client.set(cacheKey, JSON.stringify(photo), { EX: 3600 });

    return res.json(photo);
});
```

<<<SECTION 15>>>
### Content Delivery Networks, CDNs

Users far from your servers' region get slower loads because requests travel farther. A **CDN** stores copies of static content (images, videos, stylesheets) on servers worldwide called **edge servers**.

A request goes to the nearest edge server. If it has the content cached, it returns it immediately; if not, it fetches it once from the main server, caches it, and serves it to that user and all future users in the region.

This is why video streaming is smooth anywhere: you likely stream from a nearby server, not a data center on another continent.

Real world example: Steam game updates download from a CDN edge server near your city, which is why speeds are fast regardless of location.

<<<SECTION 16>>>
### Message Queues and Asynchronous Processing

Some tasks don't need to happen while the user waits and are better done in the background via **message queues**.

On a video platform, an upload is confirmed almost immediately; converting to multiple resolutions and generating thumbnails is placed as a message in a queue. Separate worker servers pull tasks and process them independently at their own pace.

Benefits of this decoupling:
- If workers are overwhelmed, tasks wait in the queue instead of the system failing.
- If a worker crashes mid-task, the task can be retried instead of lost.

Common tools: RabbitMQ and Apache Kafka. Kafka handles enormous message volumes, so it is often used for live location updates from thousands of delivery drivers, where writing each update directly to a database in real time would overwhelm it.

Real world example: Amazon checkout confirms almost instantly, while inventory updates, seller notification, and shipping are handled asynchronously through queues.

<<<SECTION 17>>>
### The CAP Theorem

Once data is spread across servers, the **CAP theorem** describes an unavoidable trade-off:
- **Consistency** - every server returns the same, most up-to-date data.
- **Availability** - the system always responds, even if some servers have problems.
- **Partition tolerance** - the system keeps working when some servers temporarily can't communicate, which inevitably happens in distributed systems.

Only two of the three can be fully guaranteed at once. Since partitions are inevitable, partition tolerance is essentially mandatory, so the real choice is consistency vs availability during a partition.

Example: a social media post may take a moment to reach all followers worldwide as it propagates. The platform chose availability (staying responsive) over strict consistency, since a slightly delayed post beats the platform going down whenever two servers lose contact.

Generally, money and critical transactions (banking) prioritize consistency; social feeds and product catalogs, where slight staleness is harmless, prioritize availability.

Real world example: DynamoDB, behind Amazon's shopping cart, was designed to favor availability: a cart that is always accessible, even if occasionally slightly outdated, beats one unavailable during a network hiccup.

<<<SECTION 18>>>
### Proxies, Forward and Reverse

A **proxy** is a server between a client and another server.

**Forward proxy** - sits in front of the client and makes requests on its behalf. Example: a VPN; the destination sees only the VPN's identity. Used to access region-restricted content or to let organizations filter which websites employees can reach.

**Reverse proxy** - sits in front of one or more servers and handles requests for them; clients never talk to backends directly. Load balancers are a common example. Also used for **SSL termination** (handling encryption/decryption so app servers don't) and for shielding backends from direct internet exposure.

Real world example: Cloudflare acts as a reverse proxy for millions of websites, absorbing traffic, filtering malicious requests, and forwarding legitimate ones while hiding the origin server's real IP.

<<<SECTION 19>>>
## How to Approach an HLD Problem, Step by Step

A beginner-friendly framework for interviews or self-practice:

### Step 1: Clarify the Requirements

Before drawing anything, establish what the system must do. For an image sharing app, ask about core features, user count, whether both uploading and viewing are needed, and what matters most: speed, consistency, or cost. Skipping this is the most common beginner mistake and leads to designs that solve the wrong problem.

### Step 2: Estimate the Scale

Estimate users, likely requests per second, and data stored over time. Exact numbers aren't needed; a system for a thousand users looks very different from one for a hundred million.

### Step 3: Define the Core Components

Identify major pieces: data storage, caching, a queue for background tasks, a CDN for media. Don't over-engineer by adding every tool you know; start simple and add complexity only with a clear reason.

### Step 4: Design the Data Flow

Trace step by step what happens on a user action. For a photo upload: request hits a load balancer, is routed to a server, the server stores the image, saves metadata to a database, and maybe triggers a background thumbnail job. Drawing the flow, even roughly, catches gaps early.

### Step 5: Identify Bottlenecks and Failure Points

Ask what happens if a server goes down, if traffic spikes, and what will bottleneck as usage grows. Caching, horizontal scaling, and redundancy come back in here. Thinking about failure early separates strong design thinking from weak.

### Step 6: Discuss Tradeoffs

Almost every decision has a trade-off: relational over NoSQL may give stronger consistency but weaker write performance at scale; aggressive caching improves speed but risks serving stale data. Explaining why you chose something and what you gave up matters more than a theoretically perfect answer; there are usually only reasonable answers backed by clear thinking.

## LLD Fundamentals, With Java Examples

### 1. Object Oriented Programming, The Foundation of LLD

Almost all LLD builds on object oriented programming, so master its four core principles before design patterns.

<<<SECTION 20>>>
### Encapsulation

**Encapsulation** bundles data with the methods that operate on it, keeping internal state private and exposing only controlled access.

```java
public class BankAccount {
    private double balance; // private, hidden from outside

    public BankAccount(double initialBalance) {
        this.balance = initialBalance;
    }

    public void deposit(double amount) {
        if (amount > 0) {
            balance += amount;
        }
    }

    public void withdraw(double amount) {
        if (amount > 0 && amount <= balance) {
            balance -= amount;
        }
    }

    public double getBalance() {
        return balance;
    }
}
```

No outside class can change balance directly; every change goes through deposit or withdraw, which enforce rules such as no negative balance.

### Abstraction

**Abstraction** exposes a simple interface and hides the complexity behind it.

```java
public abstract class PaymentProcessor {
    public abstract void processPayment(double amount);
}

public class CreditCardProcessor extends PaymentProcessor {
    @Override
    public void processPayment(double amount) {
        // complex logic: contacting bank, verifying card, fraud check
        System.out.println("Processing credit card payment of " + amount);
    }
}
```

Callers just call processPayment(amount), unaware of the bank verification and fraud checks underneath.

<<<SECTION 21>>>
### Inheritance

**Inheritance** lets a class reuse properties and behavior from a parent class.

```java
public class Vehicle {
    protected String licensePlate;
    protected int capacity;

    public Vehicle(String licensePlate, int capacity) {
        this.licensePlate = licensePlate;
        this.capacity = capacity;
    }

    public void displayInfo() {
        System.out.println("Vehicle: " + licensePlate + ", Capacity: " + capacity);
    }
}

public class Car extends Vehicle {
    public Car(String licensePlate) {
        super(licensePlate, 4);
    }
}

public class Bike extends Vehicle {
    public Bike(String licensePlate) {
        super(licensePlate, 1);
    }
}
```

Car and Bike reuse licensePlate, capacity, and displayInfo from Vehicle instead of duplicating code.

### Polymorphism

**Polymorphism**: the same method call behaves differently depending on the object.

```java
public class Car extends Vehicle {
    public Car(String licensePlate) {
        super(licensePlate, 4);
    }

    public double calculateFare(double distance, double time) {
        return distance * 10 + time * 2;
    }
}

public class Bike extends Vehicle {
    public Bike(String licensePlate) {
        super(licensePlate, 1);
    }

    public double calculateFare(double distance, double time) {
        return distance * 5;
    }
}
```

```java
Vehicle v1 = new Car("KA01AB1234");
Vehicle v2 = new Bike("KA01XY5678");
```

Calling calculateFare runs different logic for a Car or a Bike, without the calling code knowing which it has.

### 2. SOLID Principles, With Code

<<<SECTION 22>>>
### Single Responsibility Principle

A class should have only one reason to change: do one thing well. An Invoice class that both calculates the total and prints a PDF means changing printing touches price calculation, risking unrelated breakage. Fix: split into a calculator class and a printer class.

Bad, one class doing two jobs:

```java
public class Invoice {
    public double calculateTotal(List<Item> items) {
        double total = 0;
        for (Item item : items) {
            total += item.getPrice();
        }
        return total;
    }

    public void printInvoice(List<Item> items) {
        // logic to print invoice as PDF
        System.out.println("Printing invoice...");
    }
}
```

Fixed, split into two responsibilities:

```java
public class InvoiceCalculator {
    public double calculateTotal(List<Item> items) {
        double total = 0;
        for (Item item : items) {
            total += item.getPrice();
        }
        return total;
    }
}

public class InvoicePrinter {
    public void printInvoice(List<Item> items) {
        System.out.println("Printing invoice...");
    }
}
```

<<<SECTION 23>>>
### Open Closed Principle

A class should be open for extension but closed for modification: add functionality without changing existing, tested code. E.g. adding a Truck should mean creating a new Truck class that fits the structure, not modifying Vehicle's core logic for each new type.

Bad, modifying existing code to add a new type:

```java
public class DiscountCalculator {
    public double calculateDiscount(String customerType, double amount) {
        if (customerType.equals("regular")) {
            return amount * 0.05;
        } else if (customerType.equals("premium")) {
            return amount * 0.10;
        }
        return 0;
    }
}
```

Fixed, extendable without touching existing code:

```java
public interface DiscountStrategy {
    double calculate(double amount);
}

public class RegularCustomerDiscount implements DiscountStrategy {
    public double calculate(double amount) {
        return amount * 0.05;
    }
}

public class PremiumCustomerDiscount implements DiscountStrategy {
    public double calculate(double amount) {
        return amount * 0.10;
    }
}
```

A new customer type now means a new class, not edited logic.

<<<SECTION 24>>>
### Liskov Substitution Principle

Child class objects should be substitutable for parent class objects without breaking the program. If Bird has fly() and Penguin extends Bird, code assuming any Bird can fly breaks with a Penguin. Design hierarchies on actual shared behavior, not superficial similarity.

Bad, breaks the substitution rule:

```java
public class Bird {
    public void fly() {
        System.out.println("Flying");
    }
}

public class Penguin extends Bird {
    @Override
    public void fly() {
        throw new UnsupportedOperationException("Penguins can't fly");
    }
}
```

Fixed, restructure the hierarchy to reflect actual behavior:

```java
public abstract class Bird {
    public abstract void move();
}

public class Sparrow extends Bird {
    public void move() {
        System.out.println("Flying");
    }
}

public class Penguin extends Bird {
    public void move() {
        System.out.println("Swimming");
    }
}
```

<<<SECTION 25>>>
### Interface Segregation Principle

A class should not be forced to implement methods it doesn't use. A Robot implementing a Worker interface with work and eat must implement a meaningless eat. Fix: split into smaller interfaces like Workable and Eatable so classes implement only what applies.

Bad, forcing a class to implement methods it does not need:

```java
public interface Worker {
    void work();
    void eat();
}

public class RobotWorker implements Worker {
    public void work() {
        System.out.println("Robot working");
    }

    public void eat() {
        // makes no sense for a robot
        throw new UnsupportedOperationException();
    }
}
```

Fixed, split into smaller interfaces:

```java
public interface Workable {
    void work();
}

public interface Eatable {
    void eat();
}

public class RobotWorker implements Workable {
    public void work() {
        System.out.println("Robot working");
    }
}

public class HumanWorker implements Workable, Eatable {
    public void work() {
        System.out.println("Human working");
    }

    public void eat() {
        System.out.println("Human eating lunch");
    }
}
```

<<<SECTION 26>>>
### Dependency Inversion Principle

High-level modules should not depend directly on low-level modules; both should depend on abstractions. If NotificationService directly creates an EmailSender, switching to SMS means modifying NotificationService. If it depends on a MessageSender interface implemented by EmailSender and SmsSender, new methods can be swapped in without touching it.

Bad, tightly coupled to one specific implementation:

```java
public class EmailSender {
    public void send(String message) {
        System.out.println("Sending email: " + message);
    }
}

public class NotificationService {
    private EmailSender emailSender = new EmailSender();

    public void notifyUser(String message) {
        emailSender.send(message);
    }
}
```

Fixed, depending on an abstraction instead:

```java
public interface MessageSender {
    void send(String message);
}

public class EmailSender implements MessageSender {
    public void send(String message) {
        System.out.println("Sending email: " + message);
    }
}

public class SmsSender implements MessageSender {
    public void send(String message) {
        System.out.println("Sending SMS: " + message);
    }
}

public class NotificationService {
    private MessageSender messageSender;

    public NotificationService(MessageSender messageSender) {
        this.messageSender = messageSender;
    }

    public void notifyUser(String message) {
        messageSender.send(message);
    }
}
```

NotificationService now works with any MessageSender; switching email to SMS needs zero changes to it.

These five principles underlie almost every design pattern, and most well-structured codebases follow them, even when not labeled SOLID.

<<<SECTION 27>>>
### 3. Design Patterns, With Code

**Design patterns** are proven, reusable solutions to recurring design problems. They aren't rules to follow blindly but a shared vocabulary: "just use a Factory here" points to a well-understood solution, saving time and keeping code consistent with patterns others recognize.

Most useful for beginners: Singleton, Factory, Observer, Strategy, Decorator, and Builder.

### Singleton Pattern

Ensures only one instance of a class exists, with a single global access point. Example: a Logger. Multiple loggers might write differently or to different locations; one shared instance makes the whole app log consistently to one place.

```java
public class Logger {
    private static Logger instance;

    private Logger() {}

    public static Logger getInstance() {
        if (instance == null) {
            instance = new Logger();
        }
        return instance;
    }

    public void log(String message) {
        System.out.println("LOG: " + message);
    }
}
```

```java
Logger.getInstance().log("Application started");
```

Every getInstance() call returns the same shared object.

<<<SECTION 28>>>
### Factory Pattern

Used to create objects without the calling code knowing which concrete class is instantiated. For notifications via Email, SMS, or Push, a NotificationFactory takes a type ("email", "sms") and returns the right object. Adding a new type means updating only the factory, not every place that creates notifications.

```java
public interface Notification {
    void notifyUser();
}

public class EmailNotification implements Notification {
    public void notifyUser() {
        System.out.println("Sending Email Notification");
    }
}

public class SmsNotification implements Notification {
    public void notifyUser() {
        System.out.println("Sending SMS Notification");
    }
}

public class NotificationFactory {
    public static Notification createNotification(String type) {
        if (type.equalsIgnoreCase("email")) {
            return new EmailNotification();
        } else if (type.equalsIgnoreCase("sms")) {
            return new SmsNotification();
        }
        throw new IllegalArgumentException("Unknown type: " + type);
    }
}
```

```java
Notification notification = NotificationFactory.createNotification("email");
notification.notifyUser();
```

Calling code never instantiates EmailNotification or SmsNotification directly; it asks the factory.

<<<SECTION 29>>>
### Observer Pattern

Defines a one-to-many relationship: when one object changes state, all dependents are notified automatically. Example: YouTube subscriptions. You subscribe once and are notified of new uploads without checking the channel. The channel is the **subject**; each subscriber is an **observer**.

```java
public interface Observer {
    void update(String videoTitle);
}

public class Subscriber implements Observer {
    private String name;

    public Subscriber(String name) {
        this.name = name;
    }

    public void update(String videoTitle) {
        System.out.println(name + " notified: New video - " + videoTitle);
    }
}

public class Channel {
    private List<Observer> subscribers = new ArrayList<>();

    public void subscribe(Observer observer) {
        subscribers.add(observer);
    }

    public void uploadVideo(String title) {
        for (Observer observer : subscribers) {
            observer.update(title);
        }
    }
}
```

```java
Channel channel = new Channel();
channel.subscribe(new Subscriber("Harry"));
channel.subscribe(new Subscriber("Alex"));
channel.uploadVideo("System Design Basics");
```

Every subscribed observer is notified automatically when the channel uploads.

<<<SECTION 30>>>
### Strategy Pattern

Defines a family of algorithms, each in its own class, interchangeable at runtime. A shopping app with credit card, UPI, and wallet payments makes each method a strategy class implementing a common interface instead of a long if-else chain; checkout just calls the selected strategy without knowing its internals.

```java
public interface PaymentStrategy {
    void pay(double amount);
}

public class CreditCardPayment implements PaymentStrategy {
    public void pay(double amount) {
        System.out.println("Paid " + amount + " using Credit Card");
    }
}

public class UpiPayment implements PaymentStrategy {
    public void pay(double amount) {
        System.out.println("Paid " + amount + " using UPI");
    }
}

public class Checkout {
    private PaymentStrategy paymentStrategy;

    public Checkout(PaymentStrategy paymentStrategy) {
        this.paymentStrategy = paymentStrategy;
    }

    public void completePayment(double amount) {
        paymentStrategy.pay(amount);
    }
}
```

```java
Checkout checkout = new Checkout(new UpiPayment());
checkout.completePayment(500);
```

Swapping payment methods means passing a different strategy, no if-else chains.

<<<SECTION 31>>>
### Decorator Pattern

Adds behavior to an object dynamically without altering its structure. In a coffee ordering system, a base Coffee is wrapped by decorators like Milk, Sugar, or WhippedCream, each adding cost and description without modifying Coffee. Far more flexible than a class for every combination of coffee and toppings.

```java
public interface Coffee {
    double getCost();
    String getDescription();
}

public class BasicCoffee implements Coffee {
    public double getCost() {
        return 50;
    }

    public String getDescription() {
        return "Coffee";
    }
}

public abstract class CoffeeDecorator implements Coffee {
    protected Coffee decoratedCoffee;

    public CoffeeDecorator(Coffee coffee) {
        this.decoratedCoffee = coffee;
    }
}

public class MilkDecorator extends CoffeeDecorator {
    public MilkDecorator(Coffee coffee) {
        super(coffee);
    }

    public double getCost() {
        return decoratedCoffee.getCost() + 10;
    }

    public String getDescription() {
        return decoratedCoffee.getDescription() + " with Milk";
    }
}
```

```java
Coffee order = new MilkDecorator(new BasicCoffee());
System.out.println(order.getDescription() + " costs " + order.getCost());
```

Each decorator wraps the base object, adding cost and description without touching BasicCoffee.

<<<SECTION 32>>>
### Builder Pattern

Useful when an object has many optional parameters and a dozen-argument constructor becomes messy and error-prone. For a custom computer (CPU, RAM, storage, GPU, many optional), a Builder sets only the parameters you care about step by step, then a final build method returns the object, keeping creation readable and flexible.

```java
public class Computer {
    private String cpu;
    private int ram;
    private int storage;
    private String gpu;

    private Computer(Builder builder) {
        this.cpu = builder.cpu;
        this.ram = builder.ram;
        this.storage = builder.storage;
        this.gpu = builder.gpu;
    }

    public static class Builder {
        private String cpu;
        private int ram;
        private int storage;
        private String gpu;

        public Builder setCpu(String cpu) {
            this.cpu = cpu;
            return this;
        }

        public Builder setRam(int ram) {
            this.ram = ram;
            return this;
        }

        public Builder setStorage(int storage) {
            this.storage = storage;
            return this;
        }

        public Builder setGpu(String gpu) {
            this.gpu = gpu;
            return this;
        }

        public Computer build() {
            return new Computer(this);
        }
    }
}
```

```java
Computer myComputer = new Computer.Builder()
        .setCpu("Intel i7")
        .setRam(16)
        .setGpu("RTX 4060")
        .build();
```

Only the needed fields are set, and build() assembles the object instead of a long constructor parameter list.

<<<SECTION 33>>>
## UML and Class Diagrams

Experienced engineers sketch an LLD design before coding, using **UML** (Unified Modeling Language). UML is not code or a programming language but a standardized set of symbols and diagram types for representing a system's structure and behavior, so anyone familiar with it can understand how classes are organized without reading code. Beginners need not master every UML diagram; **class diagrams** are what matter for LLD, in interviews and real projects.

### Why UML Matters, Even Though It Feels Like Extra Work

Jumping straight to code usually backfires beyond three or four classes. A class diagram forces structure and relationship decisions before implementation, when mistakes are cheapest: a broken relationship takes ten seconds to fix on a whiteboard, but after two hundred lines of code may mean rewriting a big chunk. It also aligns a team on a design before anyone opens an IDE, giving a shared reference without the ambiguity of verbal descriptions.

**The Building Blocks of a Class Diagram**

Each class is a rectangle with three stacked sections:
- Top: the class name
- Middle: attributes (fields/properties) with data types
- Bottom: methods with parameters and return types

{{IMG:1}}

Visibility markers before each attribute and method show how accessible it is from outside:
- **-** private: only within the class
- **+** public: from anywhere
- **#** protected: within the class and its subclasses
- **~** package/default: only within the same package

These show which parts of a class are for external use and which stay hidden, directly reflecting encapsulation.

### The Relationships Between Classes

A class diagram's real value is showing how classes relate. Beginners often blur the distinct relationship types.

### Association

The most general relationship: one class uses or is connected to another. Drawn as a plain straight line. E.g. Teacher and Student may be linked, but neither owns the other's lifecycle; if the Teacher is destroyed, the Student still exists.

<<<SECTION 34>>>
### Aggregation

A weaker, special form of association: a "has a" relationship where the contained object can exist independently. Drawn as a line with an open (unfilled) diamond on the container's side. E.g. a Department contains Professors; if the Department is dissolved, Professors still exist and can move to another department.

### Composition

A stronger "has a" relationship where the contained object's lifecycle is tied to the container. Drawn with a filled diamond on the container's side. E.g. a House contains Rooms; destroying the House destroys its Rooms. Test: can the contained object meaningfully exist if the container disappears? Yes → aggregation; no → composition.

### Inheritance, or Generalization

An "is a" relationship: one class is a specialized version of another. Drawn as a line with a hollow triangle arrow pointing to the parent. E.g. separate lines from Car and from Bike to Vehicle, each triangle pointing up at Vehicle.

### Realization, or Implementation

The relationship between a class and an interface it implements. Drawn as a dashed line with a hollow triangle pointing to the interface, e.g. from EmailSender to MessageSender. The dashed line distinguishes interface implementation from inheriting a concrete class.

<<<SECTION 35>>>
### Dependency

The weakest, most temporary relationship: one class uses another briefly, often as a method parameter, without keeping a lasting reference. Drawn as a dashed line with a simple open arrow. E.g. an OrderService method that accepts a Logger just to log during that call, without storing it as a field, is a dependency, not an association.

**Multiplicity, Describing How Many**

Numbers or symbols near each end of a relationship line show how many instances relate:
- **1** - exactly one
- **0..1** - zero or one (optional)
- **\*** or **0..\*** - zero or many
- **1..\*** - at least one, possibly many

E.g. ParkingLot to ParkingSpot: 1 on the ParkingLot side and 1..\* on the ParkingSpot side, meaning one lot has one or more spots and each spot belongs to exactly one lot.

<<<SECTION 36>>>
### A Worked Example

Simplified class diagram for the Parking Lot:

- **ParkingLot → ParkingSpot:** composition, one to many; spots don't meaningfully exist without their lot.
- **Car, Bike, Truck → Vehicle:** inheritance, hollow triangles pointing up to Vehicle.
- **ParkingSpot – Vehicle:** association; a spot can be occupied by a vehicle, but the vehicle exists independently (e.g. on the road).
- **Ticket – Vehicle and ParkingSpot:** association; the ticket references which vehicle is in which spot without owning either.
- **ParkingLot → PaymentStrategy interface:** dependency; it briefly uses the selected strategy to calculate a fee without holding one implementation permanently.

Sketching this before writing Java makes the structure clear and mistakes (e.g. Ticket missing a reference to ParkingSpot) easy to spot in boxes and arrows rather than in half-written code.

<<<SECTION 37>>>
### Common Beginner Mistakes with UML

- **Confusing aggregation and composition** - fall back to the independent existence test.
- **Overusing inheritance** - using it whenever classes share a few fields, without a true "is a" relationship. If it doesn't hold logically (like Penguin and Bird), association or composition is usually better.
- **Diagramming everything at once** - especially in interviews, diagram only the core classes relevant to the problem, not every class and edge case up front.

### Tools for Drawing UML Diagrams

No special software is needed: a whiteboard, paper, or simple drawing tool works, especially in interviews where quick sketches are expected. For practice or documentation, [draw.io](https://x.com//draw.io), Lucidchart, or text-based PlantUML make cleaner diagrams that are easy to update.

The tool matters far less than the habit: strong LLD thinking isn't memorizing every UML symbol, but consistently sketching relationships before coding to catch structural problems while they're cheap to fix.

<<<SECTION 38>>>
## How to Approach an LLD Problem, Step by Step

The hard part is applying OOP, SOLID, and patterns to a fresh problem like "design a parking lot" or "design a vending machine." A framework, with a Parking Lot system as the running example:

### Step 1: Clarify the Requirements

Understand the problem before creating classes. Ask: different spot sizes for motorcycles, cars, and trucks? Fee calculation? Tracking available spots? Multiple entry and exit points? Skipping this leads to designing for the wrong problem; a flat-fee lot looks very different in code from one with time-based, vehicle-type-based pricing.

### Step 2: Identify the Core Objects, or Entities

List the real-world things: Vehicle, ParkingSpot, ParkingLot, Ticket, Payment. Trick: look for nouns in the problem description; any distinct "thing" with its own data and behavior is a candidate class.

### Step 3: Define Relationships Between Objects

Does a ParkingLot contain multiple ParkingSpots? Is a Vehicle assigned to exactly one ParkingSpot at a time? Is a Ticket generated on entry and closed on exit? Composition and inheritance decisions are made here, e.g. Car, Bike, and Truck inherit from Vehicle, sharing license plate and vehicle type but differing in which spot sizes they can occupy.

### Step 4: Identify Behaviors and Assign Responsibilities

Define what each class does: ParkingLot finds an available spot and assigns it to an incoming vehicle; ParkingSpot marks itself occupied or free; Ticket calculates the final fee from parking duration. Apply the Single Responsibility Principle: spread responsibility across focused classes rather than one giant ParkingLot class.

### Step 5: Apply Relevant Design Patterns

Look for natural fits. Multiple fee calculations (hourly vs flat rate) → Strategy, swapping fee logic without changing ParkingLot. A single shared instance managing the lot's state → Singleton for ParkingLot. Don't force patterns to look impressive; a simpler pattern-free solution is often cleaner. Patterns should solve a real problem.

### Step 6: Sketch It Out Before Coding

Sketch a rough class diagram with each class, key attributes, and key methods; a box-and-arrow sketch on paper is enough. It catches problems early, e.g. Ticket missing a reference back to its Vehicle, before fifty lines are written around a flawed structure.

### Step 7: Write Clean, Incremental Code

Code one class at a time, foundational ones first (Vehicle), then dependents (ParkingSpot, then ParkingLot). Keep checking against SOLID: is a class doing too much, is something hardcoded that should be flexible, and would a new feature (new vehicle type or pricing model) require rewriting existing code or just adding new code?

### Step 8: Handle Edge Cases

Once the core works, consider: the lot is full when a vehicle arrives; a ticket is lost; two vehicles assigned the same spot due to a timing issue. Thinking these through shows maturity beyond the happy path.

<<<SECTION 39>>>
## A Beginner's Practice Roadmap

A learning order that avoids trying to learn everything at once:

### Stage 1: Build the Vocabulary First

Before any design problems, understand the building blocks: servers, load balancers, databases, caching, CDNs, message queues. You should instantly understand phrases like "we cached this at the edge" or "the write goes to the master node." Test yourself by explaining each concept aloud in plain language to an imagined novice; struggling means you memorized the term without understanding it.

### Stage 2: Study Simple, Well Known Systems

Read high-level breakdowns of smaller systems: a URL shortener, a rate limiter, a basic chat app, which are better starting points than all of Instagram. You aren't designing yet, just pattern matching how caching, load balancing, and queues recur in different combinations.

### Stage 3: Attempt Your Own Designs, Badly at First

Design simple systems (a URL shortener, a basic notification system) yourself before looking at solutions, walking through the framework: clarify requirements, estimate scale, define components, design data flow. Early attempts will be rough; the value is forcing yourself to make and justify decisions, as in a real interview or job.

### Stage 4: Move to LLD in Parallel

Don't wait to master HLD; practice LLD alongside it, since they reinforce each other. Start with a parking lot, vending machine, or library management system, and write the code, not just diagrams. Apply SOLID and use patterns only when they solve a real problem. Writing code, even messy, builds intuition reading never will.

### Stage 5: Study Harder, More Specific Systems

With solid fundamentals, design Twitter, Netflix, or a ride sharing app. These force combining concepts (sharding plus caching plus message queues), where real system design thinking develops.

### Stage 6: Practice Explaining Your Design, Not Just Building It

Practice explaining your design aloud, including trade-offs. If you chose NoSQL over SQL for a component, explain exactly why and what you gave up. This matters in interviews and in team discussions where decisions must be justified.

### A Note on Pacing

Don't rush the stages in a week; the skill builds through repeated exposure over time. Revisiting concepts a few weeks apart, with more context, often teaches more than one careful first read.

<<<SECTION 40>>>
## Ending Notes

Recap: the split between HLD and LLD and why both matter. HLD building blocks: servers, load balancers, databases, caching, CDNs, message queues, scaling, and their trade-offs. LLD: object oriented principles, SOLID, and common design patterns that keep code clean and maintainable as it grows.

This is a map, not instant expertise: where to start, what to learn next, how the pieces fit. Progress comes from practice: pick a simple system, design it badly, learn where it breaks, and repeat. The next step is to start designing something, even something small.
