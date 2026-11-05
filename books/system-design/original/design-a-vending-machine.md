# Design a Vending Machine

<<<SECTION 1>>>
## Overview (Problem Statement)

A Vending Machine looks simple on the surface. You put in money, press a button, get your snack. But when you sit down to design it, you realize it has a lot of moving parts(sigh). Modeling the behavior of the machine at different points in time is perhaps the trickiest part here.

If we just use if/else checks everywhere ("if money inserted, if product selected, if balance sufficient..."), our VendingMachine class becomes a mess really fast.

The clean solution is the State Pattern, where each phase of the machine's lifecycle is its own class with its own rules.

## Entities & Classes

### 1. Item (Base Class + Subtypes)

The first instinct many people have is to write separate Chips, Drink, and Chocolate classes. But if you look at them, they all have the exact same attributes: name, quantity, and price. Writing three identical classes is just copy-paste code, which violates the DRY principle (Don't Repeat Yourself).

So, write one abstract Item base class with all the common attributes, and have Chips, Drink, Chocolate extend it. Now if you ever want to add a new product type like Candy, you just extend Item & you don't touch any existing code. This follows the Open-Closed Principle (open for extension, closed for modification).

```java
abstract class Item {
    private String name;
    private int quantity;
    private int price;

    public Item(String name, int quantity, int price) {
        this.name = name;
        this.quantity = quantity;
        this.price = price;
    }

    public String getName() { return name; }
    public int getQuantity() { return quantity; }
    public int getPrice() { return price; }
    public void setQuantity(int quantity) { this.quantity = quantity; }
}

class Chips extends Item {
    public Chips(String name, int quantity, int price) { super(name, quantity, price); }
}

class Drink extends Item {
    public Drink(String name, int quantity, int price) { super(name, quantity, price); }
}

class Chocolate extends Item {
    public Chocolate(String name, int quantity, int price) { super(name, quantity, price); }
}
```

<<<SECTION 2>>>
### What & Why the State Pattern?

Before jumping into the states, let's understand why we need this pattern at all.

Imagine writing VendingMachine without it. The `selectProduct()` method would look something like:

```java
public void selectProduct(String itemName) {
    if (moneyInserted) {
        if (inventoryHasItem) {
            if (balanceSufficient) {
                // dispense
            } else {
                // error
            }
        } else {
            // error
        }
    } else {
        // error
    }
}
```

And every single method (`insertMoney`, `dispense`, `returnChange`), would have the same nested mess. Adding a new state or changing behavior means digging through all these if/else blocks.

The State Pattern says: instead of one giant class handling everything, give each state its own class. Each state only knows what's valid in that state. The machine just asks the current state to handle things, no if/else needed.

The four states of our vending machine:

```text
IDLE -> MONEY_INSERTED -> DISPENSING -> RETURNING_CHANGE -> IDLE
```

All states implement the same interface so the machine can talk to any of them the same way:

```java
interface VendingMachineState {
    void insertMoney(int amount);
    void selectProduct(String itemName);
    void dispense();
    void returnChange();
}
```

<<<SECTION 3>>>
### 2. IdleState

This is the default state where the machine is just sitting there waiting. The only valid action here is inserting money. Everything else should throw an error because it makes no sense to select a product or ask for change when nothing has happened yet.

When money is inserted, we transition to MoneyInsertedState.

```java
class IdleState implements VendingMachineState {
    private VendingMachine machine;

    public IdleState(VendingMachine machine) { this.machine = machine; }

    @Override
    public void insertMoney(int amount) {
        machine.setBalance(amount);
        machine.setState(machine.getMoneyInsertedState()); // transition
        System.out.println("Money inserted: " + amount);
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Please insert money first!");
    }

    @Override
    public void dispense() {
        throw new RuntimeException("Please insert money first!");
    }

    @Override
    public void returnChange() {
        throw new RuntimeException("No money to return!");
    }
}
```

<<<SECTION 4>>>
### 3. MoneyInsertedState

Money is in the machine. Now two things are valid, the user can add more money (so we add to the balance, not replace it), or they can select a product.

Before we let them select a product, we do two checks:

1. Does the item actually exist in inventory?
2. Is the balance enough to pay for it?

If both pass, we store the selected item on the machine (so DispensingState knows what to dispense later) and transition to DispensingState. We don't actually dispense here as selection and dispensing are two separate responsibilities.

```java
class MoneyInsertedState implements VendingMachineState {
    private VendingMachine machine;

    public MoneyInsertedState(VendingMachine machine) { this.machine = machine; }

    @Override
    public void insertMoney(int amount) {
        machine.setBalance(machine.getBalance() + amount); // add, don't replace
        System.out.println("Added more money. Total: " + machine.getBalance());
    }

    @Override
    public void selectProduct(String itemName) {
        Item item = machine.getInventory().get(itemName);

        if (item == null) throw new RuntimeException("Item not found!");

        if (machine.getBalance() < item.getPrice()) {
            throw new RuntimeException("Insufficient balance! Need: "
                + item.getPrice() + " Have: " + machine.getBalance());
        }

        machine.setSelectedItem(item); // pass context to next state
        machine.setState(machine.getDispensingState());
        System.out.println("Product selected: " + itemName);
    }

    @Override
    public void dispense() { throw new RuntimeException("Select a product first!"); }

    @Override
    public void returnChange() { throw new RuntimeException("Select a product first!"); }
}
```

<<<SECTION 5>>>
### 4. DispensingState

This is where the actual work happens. Think of it like the motor inside the machine running, it physically pushes the product out.

We deduct the item's price from the balance, reduce its quantity in inventory, and if quantity hits zero we remove it entirely. Then we decide the next state, if there's leftover balance, go to ReturningChangeState. If balance is exactly zero, go straight back to IdleState.

```java
class DispensingState implements VendingMachineState {
    private VendingMachine machine;

    public DispensingState(VendingMachine machine) { this.machine = machine; }

    @Override
    public void dispense() {
        Item item = machine.getSelectedItem();

        machine.setBalance(machine.getBalance() - item.getPrice());

        item.setQuantity(item.getQuantity() - 1);
        if (item.getQuantity() == 0) {
            machine.getInventory().remove(item.getName());
        }

        System.out.println("Dispensing: " + item.getName());

        if (machine.getBalance() > 0) {
            machine.setState(machine.getReturningChangeState());
        } else {
            machine.setState(machine.getIdleState());
        }
    }

    @Override
    public void insertMoney(int amount) {
        throw new RuntimeException("Please wait, dispensing in progress!");
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Already dispensing!");
    }

    @Override
    public void returnChange() {
        throw new RuntimeException("Wait for dispensing to complete!");
    }
}
```

<<<SECTION 6>>>
### 5. ReturningChangeState

The simplest state. The item has been dispensed but there's leftover money. We just print how much change is being returned, reset the balance to zero, and go back to IdleState. Machine is ready for the next customer.

```java
class ReturningChangeState implements VendingMachineState {
    private VendingMachine machine;

    public ReturningChangeState(VendingMachine machine) { this.machine = machine; }

    @Override
    public void returnChange() {
        System.out.println("Returning change: " + machine.getBalance());
        machine.setBalance(0);
        machine.setState(machine.getIdleState()); // back to start
    }

    @Override
    public void insertMoney(int amount) {
        throw new RuntimeException("Please collect your change first!");
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Please collect your change first!");
    }

    @Override
    public void dispense() {
        throw new RuntimeException("Already dispensed!");
    }
}
```

### 6. VendingMachine

The VendingMachine class itself is surprisingly clean. It doesn't contain a single if/else. It just holds references to all four state objects, tracks the current state, and delegates every action to whatever state is currently active.

It also holds the inventory (`Map<String, Item>` for O(1) lookup), the current balance, and the selected item (shared context between states).

```java
class VendingMachine {
    private Map<String, Item> inventory;
    private int balance;
    private Item selectedItem;

    private VendingMachineState idleState;
    private VendingMachineState moneyInsertedState;
    private VendingMachineState dispensingState;
    private VendingMachineState returningChangeState;
    private VendingMachineState currentState;

    public VendingMachine() {
        inventory = new HashMap<>();
        balance = 0;

        idleState = new IdleState(this);
        moneyInsertedState = new MoneyInsertedState(this);
        dispensingState = new DispensingState(this);
        returningChangeState = new ReturningChangeState(this);

        currentState = idleState; // always start idle
    }

    // delegates to current state - no if/else anywhere
    public void insertMoney(int amount) { currentState.insertMoney(amount); }
    public void selectProduct(String name) { currentState.selectProduct(name); }
    public void dispense() { currentState.dispense(); }
    public void returnChange() { currentState.returnChange(); }

    public void addItem(Item item) { inventory.put(item.getName(), item); }

    public Map<String, Item> getInventory() { return inventory; }
    public int getBalance() { return balance; }
    public void setBalance(int balance) { this.balance = balance; }
    public Item getSelectedItem() { return selectedItem; }
    public void setSelectedItem(Item item) { this.selectedItem = item; }
    public void setState(VendingMachineState state) { this.currentState = state; }
    public VendingMachineState getIdleState() { return idleState; }
    public VendingMachineState getMoneyInsertedState() { return moneyInsertedState; }
    public VendingMachineState getDispensingState() { return dispensingState; }
    public VendingMachineState getReturningChangeState() { return returningChangeState; }
}
```

<<<SECTION 7>>>
## Main

```java
import java.util.*;


// ITEMS

abstract class Item {
    private String name;
    private int quantity;
    private int price;

    public Item(String name, int quantity, int price) {
        this.name = name;
        this.quantity = quantity;
        this.price = price;
    }

    public String getName() { return name; }
    public int getQuantity() { return quantity; }
    public int getPrice() { return price; }
    public void setQuantity(int quantity) { this.quantity = quantity; }
}

class Chips extends Item {
    public Chips(String name, int quantity, int price) {
        super(name, quantity, price);
    }
}

class Drink extends Item {
    public Drink(String name, int quantity, int price) {
        super(name, quantity, price);
    }
}

class Chocolate extends Item {
    public Chocolate(String name, int quantity, int price) {
        super(name, quantity, price);
    }
}

// STATE INTERFACE

interface VendingMachineState {
    void insertMoney(int amount);
    void selectProduct(String itemName);
    void dispense();
    void returnChange();
}

//  IDLE STATE

class IdleState implements VendingMachineState {
    private VendingMachine machine;

    public IdleState(VendingMachine machine) {
        this.machine = machine;
    }

    @Override
    public void insertMoney(int amount) {
        machine.setBalance(amount);
        machine.setState(machine.getMoneyInsertedState());
        System.out.println("Money inserted: " + amount);
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Please insert money first!");
    }

    @Override
    public void dispense() {
        throw new RuntimeException("Please insert money first!");
    }

    @Override
    public void returnChange() {
        throw new RuntimeException("No money to return!");
    }
}

// MONEY INSERTED STATE

class MoneyInsertedState implements VendingMachineState {
    private VendingMachine machine;

    public MoneyInsertedState(VendingMachine machine) {
        this.machine = machine;
    }

    @Override
    public void insertMoney(int amount) {
        machine.setBalance(machine.getBalance() + amount);
        System.out.println("Added more money. Total: " + machine.getBalance());
    }

    @Override
    public void selectProduct(String itemName) {
        Item item = machine.getInventory().get(itemName);

        if (item == null) throw new RuntimeException("Item not found!");

        if (machine.getBalance() < item.getPrice()) {
            throw new RuntimeException("Insufficient balance! Need: "
                + item.getPrice() + " Have: " + machine.getBalance());
        }

        machine.setSelectedItem(item);
        machine.setState(machine.getDispensingState());
        System.out.println("Product selected: " + itemName);
    }

    @Override
    public void dispense() {
        throw new RuntimeException("Select a product first!");
    }

    @Override
    public void returnChange() {
        throw new RuntimeException("Select a product first!");
    }
}

// DISPENSING STATE

class DispensingState implements VendingMachineState {
    private VendingMachine machine;

    public DispensingState(VendingMachine machine) {
        this.machine = machine;
    }

    @Override
    public void dispense() {
        Item item = machine.getSelectedItem();

        machine.setBalance(machine.getBalance() - item.getPrice());

        item.setQuantity(item.getQuantity() - 1);
        if (item.getQuantity() == 0) {
            machine.getInventory().remove(item.getName());
        }

        System.out.println("Dispensing: " + item.getName());

        if (machine.getBalance() > 0) {
            machine.setState(machine.getReturningChangeState());
        } else {
            machine.setState(machine.getIdleState());
        }
    }

    @Override
    public void insertMoney(int amount) {
        throw new RuntimeException("Please wait, dispensing in progress!");
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Already dispensing!");
    }

    @Override
    public void returnChange() {
        throw new RuntimeException("Wait for dispensing to complete!");
    }
}

// RETURNING CHANGE STATE

class ReturningChangeState implements VendingMachineState {
    private VendingMachine machine;

    public ReturningChangeState(VendingMachine machine) {
        this.machine = machine;
    }

    @Override
    public void returnChange() {
        System.out.println("Returning change: " + machine.getBalance());
        machine.setBalance(0);
        machine.setState(machine.getIdleState());
    }

    @Override
    public void insertMoney(int amount) {
        throw new RuntimeException("Please collect your change first!");
    }

    @Override
    public void selectProduct(String itemName) {
        throw new RuntimeException("Please collect your change first!");
    }

    @Override
    public void dispense() {
        throw new RuntimeException("Already dispensed!");
    }
}

//  VENDING MACHINE
class VendingMachine {
    private Map<String, Item> inventory;
    private int balance;
    private Item selectedItem;

    private VendingMachineState idleState;
    private VendingMachineState moneyInsertedState;
    private VendingMachineState dispensingState;
    private VendingMachineState returningChangeState;

    private VendingMachineState currentState;

    public VendingMachine() {
        inventory = new HashMap<>();
        balance = 0;

        idleState = new IdleState(this);
        moneyInsertedState = new MoneyInsertedState(this);
        dispensingState = new DispensingState(this);
        returningChangeState = new ReturningChangeState(this);

        currentState = idleState;
    }

    public void insertMoney(int amount) { currentState.insertMoney(amount); }
    public void selectProduct(String name) { currentState.selectProduct(name); }
    public void dispense() { currentState.dispense(); }
    public void returnChange() { currentState.returnChange(); }

    public void addItem(Item item) { inventory.put(item.getName(), item); }

    public Map<String, Item> getInventory() { return inventory; }
    public int getBalance() { return balance; }
    public void setBalance(int balance) { this.balance = balance; }
    public Item getSelectedItem() { return selectedItem; }
    public void setSelectedItem(Item item) { this.selectedItem = item; }
    public void setState(VendingMachineState state) { this.currentState = state; }
    public VendingMachineState getIdleState() { return idleState; }
    public VendingMachineState getMoneyInsertedState() { return moneyInsertedState; }
    public VendingMachineState getDispensingState() { return dispensingState; }
    public VendingMachineState getReturningChangeState() { return returningChangeState; }
}

// MAIN

public class Main {
    public static void main(String[] args) {
        VendingMachine vm = new VendingMachine();

        vm.addItem(new Chips("Lays", 3, 20));
        vm.addItem(new Drink("Coke", 2, 50));
        vm.addItem(new Chocolate("KitKat", 1, 30));

        System.out.println("--- Normal Flow ---");
        vm.insertMoney(60);
        vm.selectProduct("Coke");
        vm.dispense();
        vm.returnChange();

        System.out.println("\n--- Insufficient Balance ---");
        try {
            vm.insertMoney(10);
            vm.selectProduct("Coke");
        } catch (RuntimeException e) {
            System.out.println("Error: " + e.getMessage());
        }

        System.out.println("\n--- No Money Inserted ---");
        // A new machine, because vm is still holding the 10 inserted above
        VendingMachine emptyMachine = new VendingMachine();
        try {
            emptyMachine.selectProduct("Lays");
        } catch (RuntimeException e) {
            System.out.println("Error: " + e.getMessage());
        }
    }
}
```

### Output

```text
--- Normal Flow ---
Money inserted: 60
Product selected: Coke
Dispensing: Coke
Returning change: 10

--- Insufficient Balance ---
Money inserted: 10
Error: Insufficient balance! Need: 50 Have: 10

--- No Money Inserted ---
Error: Please insert money first!
```

## Key Design Decisions

- **Base Item class:** All products have the same structure, so there's no need for three separate classes. Extending Item is all you need for new product types.
- **`Map<String, Item>` for inventory:** Looking up a product by name is O(1) with a map. A list would mean scanning every item every time.
- **State Pattern:** Splits behavior cleanly across states. No giant if/else in VendingMachine. Adding a new state means adding a new class, not editing existing ones.
- **selectedItem on VendingMachine:** MoneyInsertedState picks the item, DispensingState uses it. Storing it on the machine is how we pass that context across states.
- **Dispense separate from selectProduct:** Selecting and physically dispensing are two different actions. Keeping them in separate states makes the flow clearer and more realistic.
