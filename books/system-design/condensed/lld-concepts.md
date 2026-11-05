# LLD Concepts

<<<SECTION 1>>>
## The Foundation

Low-Level Design translates requirements into clean, maintainable code structures. Before problems like a parking lot, chess game, or ride-sharing system, you need the fundamentals: OOP, design principles, and design patterns.

## 1. Object-Oriented Programming (OOP)

OOP is the backbone of LLD: every design is expressed through classes, objects, and their relationships. Four pillars:

### Encapsulation

Bundle data and the methods that operate on it into one class, and restrict direct access to internals.

```java
public class BankAccount {
    private double balance; // hidden from outside

    public BankAccount(double initialBalance) {
        this.balance = initialBalance;
    }

    public void deposit(double amount) {
        if (amount > 0) balance += amount;
    }

    public void withdraw(double amount) {
        if (amount > 0 && amount <= balance) balance -= amount;
    }

    public double getBalance() {
        return balance;
    }
}
```

Outsiders can't touch `balance` directly; they must use the controlled interface, protecting data integrity.

### Abstraction

Hide complexity and expose only what the caller needs. In Java: abstract classes and interfaces.

```java
public interface PaymentProcessor {
    void processPayment(double amount);
    boolean refund(double amount);
}

public class StripeProcessor implements PaymentProcessor {
    @Override
    public void processPayment(double amount) {
        // Stripe-specific HTTP calls, auth, retries are all hidden
        System.out.println("Processing $" + amount + " via Stripe");
    }

    @Override
    public boolean refund(double amount) {
        System.out.println("Refunding $" + amount + " via Stripe");
        return true;
    }
}
```

The caller knows only `PaymentProcessor`, not whether Stripe, Razorpay, or PayPal is underneath.

### Inheritance

A child class inherits fields and methods from a parent, extending or specializing its behavior.

```java
public class Vehicle {
    protected String brand;
    protected int speed;

    public Vehicle(String brand, int speed) {
        this.brand = brand;
        this.speed = speed;
    }

    public void move() {
        System.out.println(brand + " is moving at " + speed + " km/h");
    }
}

public class ElectricCar extends Vehicle {
    private int batteryLevel;

    public ElectricCar(String brand, int speed, int batteryLevel) {
        super(brand, speed);
        this.batteryLevel = batteryLevel;
    }

    public void chargeBattery() {
        System.out.println("Charging " + brand + "... Battery: " + batteryLevel + "%");
    }
}
```

`ElectricCar` gets `move()` free and adds `chargeBattery()`. Prefer composition over inheritance when the relationship isn't a clean "is-a."

### Polymorphism

One interface, many forms; the right method is picked at runtime.

```java
public class Shape {
    public double area() {
        return 0;
    }
}

public class Circle extends Shape {
    private double radius;
    public Circle(double radius) { this.radius = radius; }

    @Override
    public double area() {
        return Math.PI * radius * radius;
    }
}

public class Rectangle extends Shape {
    private double width, height;
    public Rectangle(double width, double height) {
        this.width = width; this.height = height;
    }

    @Override
    public double area() {
        return width * height;
    }
}

// Usage
List<Shape> shapes = List.of(new Circle(5), new Rectangle(4, 6));
for (Shape s : shapes) {
    System.out.println("Area: " + s.area()); // correct method picked at runtime
}
```

The loop just calls `area()` on any `Shape` and gets the right answer.

<<<SECTION 2>>>
## 2. SOLID Design Principles

Five principles that make code easier to extend and harder to break.

### S - Single Responsibility Principle

A class should have only one reason to change.

```java
// BAD: this class does too many things
public class UserService {
    public void saveUser(User user) { /* DB logic */ }
    public void sendWelcomeEmail(User user) { /* Email logic */ }
    public String generateReport(User user) { /* Report logic */ }
}

// GOOD: each class owns one concern
public class UserRepository {
    public void save(User user) { /* DB logic only */ }
}

public class EmailService {
    public void sendWelcomeEmail(User user) { /* Email only */ }
}

public class UserReportGenerator {
    public String generate(User user) { /* Report only */ }
}
```

Changing the email template changes only `EmailService`.

### O - Open/Closed Principle

Open for extension, closed for modification: add behavior with new code, not by editing existing code.

```java
public interface DiscountStrategy {
    double apply(double price);
}

public class SeasonalDiscount implements DiscountStrategy {
    public double apply(double price) { return price * 0.9; }
}

public class LoyaltyDiscount implements DiscountStrategy {
    public double apply(double price) { return price * 0.85; }
}

public class PriceCalculator {
    public double finalPrice(double price, DiscountStrategy strategy) {
        return strategy.apply(price);
    }
}
```

A new "Student Discount" is a new class; `PriceCalculator` is never touched.

### L - Liskov Substitution Principle

A subclass must be fully substitutable for its parent without breaking the program.

```java
public class Bird {
    public void fly() {
        System.out.println("Flying...");
    }
}

// VIOLATION: Penguin can't fly so substituting Bird with Penguin breaks callers
public class Penguin extends Bird {
    @Override
    public void fly() {
        throw new UnsupportedOperationException("Penguins can't fly!");
    }
}
```

```java
// Good practice: Redesign the hierarchy
public interface Flyable {
    void fly();
}

public class Sparrow implements Flyable {
    public void fly() { System.out.println("Sparrow flying"); }
}

public class Penguin {
    public void swim() { System.out.println("Penguin swimming"); }
}
```

If a subclass breaks the parent's contract, the inheritance is wrong.

### I - Interface Segregation Principle

Don't force classes to implement methods they don't need; prefer many small, focused interfaces over one fat one.

```java
// BAD: one bloated interface
public interface Worker {
    void work();
    void eat();
    void sleep();
}

// A robot worker shouldn't implement eat() and sleep()
// GOOD: split by capability
public interface Workable { void work(); }
public interface Eatable   { void eat();  }
public interface Sleepable { void sleep(); }

public class HumanWorker implements Workable, Eatable, Sleepable {
    public void work()  { System.out.println("Human working");  }
    public void eat()   { System.out.println("Human eating");   }
    public void sleep() { System.out.println("Human sleeping"); }
}

public class RobotWorker implements Workable {
    public void work() { System.out.println("Robot working"); }
}
```

### D-Dependency Inversion Principle

High-level modules shouldn't depend on low-level modules; both depend on abstractions.

```java
// BAD: high-level class is tightly coupled to a specific DB
public class OrderService {
    private MySQLDatabase db = new MySQLDatabase(); // concrete dependency
    public void placeOrder(Order order) { db.save(order); }
}
```

```java
// GOOD: depend on an interface
public interface Database {
    void save(Order order);
}

public class MySQLDatabase implements Database {
    public void save(Order order) { System.out.println("Saving to MySQL"); }
}

public class MongoDatabase implements Database {
    public void save(Order order) { System.out.println("Saving to MongoDB"); }
}

public class OrderService {
    private final Database db;

    public OrderService(Database db) { // injected from outside
        this.db = db;
    }

    public void placeOrder(Order order) { db.save(order); }
}
```

`MySQLDatabase` can be swapped for `MongoDatabase` without touching `OrderService`.

## 3. Design Patterns

Reusable, proven templates for recurring problems (not complete programs). Three categories: **Creational**, **Structural**, **Behavioral**.

<<<SECTION 3>>>
### 1. Creational Design Patterns

Focus on object creation mechanisms.

#### Singleton Pattern

Ensures only one object of a class exists in the application. Used for logging, database connections, configuration managers, cache systems.

```java
class Singleton {

    private static Singleton instance;

    private Singleton() {}

    public static Singleton getInstance() {

        if(instance == null) {
            instance = new Singleton();
        }

        return instance;
    }
}

public class Main {

    public static void main(String[] args) {

        Singleton s1 = Singleton.getInstance();
        Singleton s2 = Singleton.getInstance();

        System.out.println(s1 == s2);
    }
}
```

**Note:** not thread-safe; two threads calling `getInstance()` simultaneously can each create an object. In multi-threaded code, create the instance eagerly or use an enum.

#### Factory Pattern

Creates objects without exposing creation logic to the client; instead of `new`, the factory decides which object to create.

```java
interface Vehicle {
    void drive();
}

class Car implements Vehicle {

    public void drive() {
        System.out.println("Driving Car");
    }
}

class Bike implements Vehicle {

    public void drive() {
        System.out.println("Driving Bike");
    }
}

class VehicleFactory {

    static Vehicle getVehicle(String type) {

        if(type.equalsIgnoreCase("car")) {
            return new Car();
        }

        if(type.equalsIgnoreCase("bike")) {
            return new Bike();
        }

        throw new IllegalArgumentException("Unknown vehicle type: " + type);
    }
}

public class Main {

    public static void main(String[] args) {

        Vehicle vehicle = VehicleFactory.getVehicle("car");

        vehicle.drive();
    }
}
```

**Advantages:** loose coupling, better scalability, cleaner object creation.

#### Builder Pattern

Constructs complex objects step by step; especially useful for classes with many fields.

```java
class User {

    private String name;
    private int age;

    private User(UserBuilder builder) {
        this.name = builder.name;
        this.age = builder.age;
    }

    static class UserBuilder {

        private String name;
        private int age;

        UserBuilder setName(String name) {
            this.name = name;
            return this;
        }

        UserBuilder setAge(int age) {
            this.age = age;
            return this;
        }

        User build() {
            return new User(this);
        }
    }
}

public class Main {

    public static void main(String[] args) {

        User user = new User.UserBuilder()
                            .setName("Harry")
                            .setAge(22)
                            .build();
    }
}
```

<<<SECTION 4>>>
### 2. Structural Design Patterns

Deal with how classes and objects are organized.

#### Adapter Pattern

Lets incompatible interfaces work together, like a charger adapter.

```java
interface AndroidCharger {
    void charge();
}

class IphoneCharger {

    void chargeIphone() {
        System.out.println("Charging iPhone");
    }
}

class ChargerAdapter implements AndroidCharger {

    private IphoneCharger iphoneCharger;

    ChargerAdapter(IphoneCharger iphoneCharger) {
        this.iphoneCharger = iphoneCharger;
    }

    public void charge() {
        iphoneCharger.chargeIphone();
    }
}

public class Main {

    public static void main(String[] args) {

        AndroidCharger charger =
                new ChargerAdapter(new IphoneCharger());

        charger.charge();
    }
}
```

**Advantages:** improves compatibility, encourages code reuse, reduces dependency issues.

#### Decorator Pattern

Adds functionality to objects dynamically without modifying their structure.

```java
interface Coffee {
    int cost();
}

class BasicCoffee implements Coffee {

    public int cost() {
        return 100;
    }
}

class MilkDecorator implements Coffee {

    private Coffee coffee;

    MilkDecorator(Coffee coffee) {
        this.coffee = coffee;
    }

    public int cost() {
        return coffee.cost() + 20;
    }
}

public class Main {

    public static void main(String[] args) {

        Coffee coffee =
                new MilkDecorator(new BasicCoffee());

        System.out.println(coffee.cost());
    }
}
```

**Output** (milk added dynamically):

```text
120
```

#### Facade Pattern

Provides a single simplified entry point to a complex system instead of exposing every subsystem.

```java
class CPU {
    void start() {
        System.out.println("CPU Started");
    }
}

class RAM {
    void load() {
        System.out.println("RAM Loaded");
    }
}

class HardDrive {
    void read() {
        System.out.println("Hard Drive Read");
    }
}

class ComputerFacade {

    private CPU cpu = new CPU();
    private RAM ram = new RAM();
    private HardDrive hardDrive = new HardDrive();

    void startComputer() {

        cpu.start();
        ram.load();
        hardDrive.read();
    }
}

public class Main {

    public static void main(String[] args) {

        ComputerFacade computer = new ComputerFacade();

        computer.startComputer();
    }
}
```

<<<SECTION 5>>>
### 3. Behavioral Design Patterns

Focus on communication between objects.

#### Observer Pattern

A one-to-many dependency: many objects are notified automatically when one changes. Examples: YouTube subscriptions, notification systems, event listeners.

```java
import java.util.*;

interface Observer {
    void update(String message);
}

class User implements Observer {

    private String name;

    User(String name) {
        this.name = name;
    }

    public void update(String message) {
        System.out.println(name + " received: " + message);
    }
}

class YoutubeChannel {

    private List<Observer> subscribers = new ArrayList<>();

    void subscribe(Observer observer) {
        subscribers.add(observer);
    }

    void notifyUsers(String video) {

        for(Observer observer : subscribers) {
            observer.update(video);
        }
    }
}

public class Main {

    public static void main(String[] args) {

        YoutubeChannel channel = new YoutubeChannel();

        channel.subscribe(new User("Harry"));
        channel.subscribe(new User("Alex"));

        channel.notifyUsers("New video uploaded");
    }
}
```

#### Strategy Pattern

Selects behavior dynamically at runtime. Heavily used in payment systems, sorting mechanisms, authentication providers.

```java
interface PaymentStrategy {
    void pay(int amount);
}

class CardPayment implements PaymentStrategy {

    public void pay(int amount) {
        System.out.println("Paid using Card");
    }
}

class UpiPayment implements PaymentStrategy {

    public void pay(int amount) {
        System.out.println("Paid using UPI");
    }
}

class ShoppingCart {

    private PaymentStrategy strategy;

    ShoppingCart(PaymentStrategy strategy) {
        this.strategy = strategy;
    }

    void checkout(int amount) {
        strategy.pay(amount);
    }
}

public class Main {

    public static void main(String[] args) {

        ShoppingCart cart =
                new ShoppingCart(new UpiPayment());

        cart.checkout(1000);
    }
}
```

## How it all connects

OOP gives the building blocks, SOLID the rules for using them well, and design patterns proven blueprints for common situations.
