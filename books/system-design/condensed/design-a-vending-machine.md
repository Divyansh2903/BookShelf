# Design a Vending Machine

<<<SECTION 1>>>
## Overview (Problem Statement)

A vending machine looks simple (insert money, press a button, get a snack) but has many moving parts. The trickiest part is modeling its behavior at different points in time.

If/else checks everywhere ("if money inserted, if product selected, if balance sufficient...") quickly make VendingMachine a mess. The clean solution is the **State Pattern**: each lifecycle phase is its own class with its own rules.

## Entities & Classes

### 1. Item (Base Class + Subtypes)

Separate Chips, Drink, and Chocolate classes would share identical attributes (name, quantity, price), violating **DRY** (Don't Repeat Yourself). Instead, one abstract Item base class holds the common attributes and the subtypes extend it. A new type like Candy just extends Item without touching existing code: the **Open-Closed Principle** (open for extension, closed for modification).

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

Without it, `selectProduct()` would look like:

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

Every method (`insertMoney`, `dispense`, `returnChange`) would repeat this nesting, and adding a state or changing behavior means digging through all of it.

With the State Pattern, each state gets its own class that knows only what's valid in that state. The machine delegates to the current state, with no if/else. The four states:

```text
IDLE -> MONEY_INSERTED -> DISPENSING -> RETURNING_CHANGE -> IDLE
```

All states implement one interface so the machine treats them uniformly:

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

Default waiting state. Only inserting money is valid (it transitions to MoneyInsertedState); selecting a product or asking for change throws an error.

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

Two actions are valid: insert more money (added to the balance, not replacing it) or select a product. Selection checks:
1. Does the item exist in inventory?
2. Is the balance enough?

If both pass, the selected item is stored on the machine (so DispensingState knows what to dispense) and the state moves to DispensingState. No dispensing here: selection and dispensing are separate responsibilities.

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

The actual work, like the machine's motor pushing the product out. Deduct the price from the balance, decrement the item's quantity, and remove it from inventory if quantity hits zero. Next state: ReturningChangeState if balance remains, otherwise IdleState.

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

Simplest state: item dispensed, money left over. Print the change returned, reset balance to zero, and return to IdleState for the next customer.

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

Contains no if/else. It holds references to the four states, tracks the current one, and delegates every action to it. It also holds the inventory (`Map<String, Item>` for O(1) lookup), the balance, and the selected item (context shared between states).

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

- **Base Item class:** products share one structure; new types just extend Item.
- **`Map<String, Item>` inventory:** O(1) lookup by name vs scanning a list.
- **State Pattern:** behavior split across states, no giant if/else; a new state is a new class, not edits to existing ones.
- **selectedItem on VendingMachine:** MoneyInsertedState picks it, DispensingState uses it; the machine carries that context between states.
- **Dispense separate from selectProduct:** selecting and physically dispensing are different actions; separate states make the flow clearer and more realistic.
