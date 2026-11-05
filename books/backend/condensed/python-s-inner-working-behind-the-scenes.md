# Python's Inner Working - Behind The Scenes

<<<SECTION 1>>>
A lot happens between typing `print("Hello")` and seeing the output. This is the full journey, step by step.

## Step 1: You Write Source Code

Everything starts with a `.py` file, which is plain text. The CPU only understands machine code (1s and 0s specific to that CPU), so Python must convert readable code into something the machine can run.

## Step 2: Tokenizing (Lexical Analysis)

Python reads the source character by character and breaks it into **tokens**, the "words" of the code. For `x = 5 + 3`:

- `x` (a name)
- `=` (an operator)
- `5` (a number)
- `+` (an operator)
- `3` (a number)

This step only identifies pieces; it doesn't care about meaning yet.

<<<SECTION 2>>>
## Step 3: Parsing and Building the AST

The **parser** arranges tokens into an **AST (Abstract Syntax Tree)** representing the code's grammatical structure, like subjects, verbs, and objects in a sentence. For `x = 5 + 3`, conceptually:

```
Assign
 ├── Target: x
 └── Value: BinOp
       ├── Left: 5
       ├── Op: +
       └── Right: 3
```

The tree shows which operation depends on what. Syntax errors (missing colon, unclosed bracket) are usually caught here as a `SyntaxError`.

View the tree with the built-in `ast` module:

```python
import ast
tree = ast.parse("x = 5 + 3")
print(ast.dump(tree))
```

<<<SECTION 3>>>
## Step 4: Compiling to Bytecode

The tree is compiled to **bytecode**: a low-level, simplified instruction set. It is not machine code, but much closer to something a machine can process quickly.

When modules are imported, bytecode is stored in `.pyc` files in a `__pycache__` folder. On later runs, if the source hasn't changed, Python reuses the saved bytecode instead of tokenizing and parsing again, so startup can be a bit faster.

View a function's bytecode with the `dis` module:

```python
import dis

def add(a, b):
    return a + b

dis.dis(add)
```

Output, roughly:

```
LOAD_FAST                a
LOAD_FAST                b
BINARY_ADD
RETURN_VALUE
```

These are simple stack-based operations: load a value, load another, add them, return the result.

<<<SECTION 4>>>
## Step 5: The Python Virtual Machine (PVM)

The CPU doesn't execute bytecode directly. The **Python Virtual Machine (PVM)** does: a big loop written in C (standard Python, **CPython**, is written in C), internally called the **"eval loop"**, that reads bytecode instructions one by one and performs the matching action. For an instruction like `BINARY_ADD`, it calls the right C function to perform the addition on the CPU.

This is why Python is considered interpreted. C or Rust compile directly to machine code the CPU runs on its own; Python always needs the VM in between, translating instructions on the fly.

<<<SECTION 5>>>
## Step 6: Stack-Based Execution

The PVM tracks values with a **stack** (last in, first out, like a stack of plates):

```
LOAD_FAST a       # push value of a onto the stack
LOAD_FAST b       # push value of b onto the stack
BINARY_ADD        # pop both values, add them, push result
RETURN_VALUE      # pop and return the result
```

Every Python operation, however complex, ultimately breaks down into these tiny stack operations.

## Step 7: Frames and the Call Stack

Each function call creates a new **frame**, a workspace holding:
- Local variables for that function
- The bytecode being executed
- A pointer to where execution currently is
- A reference back to the calling frame

Frames stack up into the **call stack**. If A calls B and B calls C, there are three frames; when C finishes, its frame is removed and control returns to B, and so on.

Deep recursion raises a `RecursionError` because each recursive call adds a frame and there is a limit on how many can pile up.

<<<SECTION 6>>>
## Step 8: Memory Management and Reference Counting

Every Python object (number, string, list, custom class instance) has a **reference count**: how many places currently point to it.

```python
a = [1, 2, 3]   # reference count of the list becomes 1
b = a           # reference count becomes 2
del a           # reference count becomes 1
del b           # reference count becomes 0, memory is freed
```

When the count reaches zero, Python frees the memory immediately.

## Step 9: The Garbage Collector

Reference counting can't handle a **reference cycle**: objects that reference each other while nothing else references them.

```
class Node:
    def __init__(self):
        self.other = None

a = Node()
b = Node()
a.other = b
b.other = a
```

After deleting `a` and `b`, they still reference each other, so their counts never reach zero. Python's separate **garbage collector** periodically finds and cleans up such cycles.

<<<SECTION 7>>>
## Step 10: The Global Interpreter Lock (GIL)

In CPython, the **GIL (Global Interpreter Lock)** lets only one thread execute Python bytecode at a time, even on many CPU cores.

It exists mainly to keep memory management, especially reference counting, safe and simple: without it, two threads could change a reference count simultaneously and corrupt it.

So Python threads suit tasks that mostly wait (downloading files, reading from a database), but not concurrent heavy CPU computation. For true parallel CPU work, use multiple processes instead, e.g. the `multiprocessing` module.

**Putting it all together:**
1. You write source code in a `.py` file
2. Python tokenizes it into tokens
3. The parser builds an Abstract Syntax Tree
4. The compiler turns the tree into bytecode
5. Bytecode is cached in `__pycache__` for faster future runs
6. The PVM reads bytecode instruction by instruction
7. Each instruction runs on a stack-based system
8. Function calls create frames that stack up
9. Reference counting tracks and frees memory automatically
10. The garbage collector cleans up leftover reference cycles
11. The GIL ensures only one thread runs bytecode at a time

This explains everyday behavior:
- Python is slower than compiled languages like C because of the VM translation layer.
- The first import of a large module can be slow; later ones are faster due to bytecode caching.
- Deep recursion fails because of the frame stack limit.
- Threads don't speed up CPU-heavy tasks as expected because of the GIL.
- Memory usually cleans itself up thanks to reference counting plus the garbage collector.

Python hides this pipeline behind a simple-looking language.
