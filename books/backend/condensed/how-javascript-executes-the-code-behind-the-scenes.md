# How JavaScript Executes The Code - Behind The Scenes

<<<SECTION 1>>>
Under the hood, a pipeline turns readable source code into machine instructions the CPU executes. Here it is stage by stage, as V8 (the engine behind Chrome and Node.js) does it.

## Stage 1: The Source Code

It starts with a plain-text **.js** file on disk. The engine turns it into something the machine understands in several phases, not one "compile everything at once" step; engines do just enough work at the right time.

## Stage 2: Lexical Analysis (Tokenizing)

The engine reads the raw text character by character and breaks it into **tokens** (tokenizing, or lexical analysis). This line:

```javascript
let x = 10 + 5;
```

becomes tokens: let, x, =, 10, +, 5, ;

Each token has a type (keyword, identifier, number, operator, punctuation) and a value. The tokenizer ignores meaning; it chops text into pieces and discards extra whitespace and comments.

<<<SECTION 2>>>
## Stage 3: Parsing and the Abstract Syntax Tree (AST)

The **parser** turns the flat token list into an **Abstract Syntax Tree (AST)** representing the program's grammatical structure. let x = 10 + 5; becomes something like:

{{IMG:1}}

Every statement, expression, and declaration becomes a node. Babel and ESLint also work by generating and walking an AST.

V8 parses in two passes for performance:

1. A quick **pre-parse** scans function bodies without fully parsing them, skipping functions not called immediately (parsing is expensive and many functions never run).
2. A **full parse** happens only when a function is about to execute.

This **lazy parsing** is one reason JS engines start fast even for huge codebases.

<<<SECTION 3>>>
## Stage 4: From AST to Bytecode

Modern engines do not interpret the AST directly line by line; walking a tree is slow (constant pointer chasing and node-type checks).

Instead V8's interpreter, **Ignition**, compiles the AST into compact **bytecode**: not machine code, but a lower-level, engine-specific instruction set between JS and CPU instructions. For example:

LdaSmi \[10\]  
Star r0  
LdaSmi \[5\]  
Add r0

These are small generic instructions ("load a value", "add two registers", "store into a variable"). Bytecode is compact, quick to generate, and quick to start executing, so JS runs almost immediately instead of waiting for a heavy full compilation like C++.

<<<SECTION 4>>>
## Stage 5: Interpretation Begins

Ignition executes the bytecode immediately in an interpreter loop. This starts fast, but long-term it's not the fastest, since each instruction carries interpretation overhead.

While interpreting, the engine **profiles** the code (gathers type feedback), watching:

- What types of values flow into a function (numbers, strings, objects)
- Which functions are called repeatedly (hot functions)
- What shapes objects have (properties and structure)

## Stage 6: The JIT Compiler Kicks In

**JIT (Just In Time)** compilation is the key to modern JS performance. Compiling everything to machine code upfront would be slow to start and wasteful for code that runs once, so the engine waits and watches.

When a function is called many times (a **hot function**), V8's optimizing compiler **TurboFan** takes the bytecode plus the collected type feedback and compiles it into highly optimized machine code that the CPU runs natively, with no interpretation step.

It's faster because it makes assumptions from what it observed. If a function always received numbers, TurboFan can skip JS's usual type checks and emit raw number math.

<<<SECTION 5>>>
## Stage 7: Deoptimization (The Safety Net)

JS is dynamically typed, so JIT assumptions can turn out wrong, e.g. a function optimized for numbers is later called with a string. The optimized code would give wrong results, so the engine discards it and falls back to the bytecode interpreter: **deoptimization** ("bailing out").

If types stabilize again, the function can be re-optimized. That's why consistent, predictable code (same types, same object shapes) usually runs faster: the JIT stays confident instead of constantly bailing out.

## Stage 8: Hidden Classes and Inline Caching

**Hidden classes:** JS objects lack fixed structures like Java/C++ classes, but V8 assigns hidden classes ("shapes") based on property structure. Objects with the same properties in the same order share one. This lets the engine treat objects almost like fixed-layout structs, much faster than a hash map lookup each time.

**Inline caching:** When the engine repeatedly sees the same operation, like accessing [obj.name](https://x.com//obj.name), it caches the property's location based on the hidden class and next time jumps straight to that memory location. This greatly speeds up repeated property access, which is extremely common in JS.

<<<SECTION 6>>>
## Putting It All Together

The full pipeline:

1. Source code (.js file)
2. Tokenizer (lexical analysis, produces tokens)
3. Parser (produces Abstract Syntax Tree)
4. Ignition (compiles AST to bytecode, interprets it)
5. Profiler (collects type feedback while running)
6. TurboFan (JIT compiles hot bytecode into optimized machine code)
7. CPU executes machine code directly
8. (if assumptions break) Deoptimize back to bytecode

The underlying trade-off: pure interpreters are fast to start but slow to run; pure compilers are fast to run but slow to start (they must fully compile first). JS engines get both by starting with an interpreter, upgrading hot paths to compiled machine code on the fly, and keeping the ability to fall back if optimizations prove wrong.

This is also why JS microbenchmarks can mislead: code run once never leaves the interpreter, while code in a tight loop run thousands of times gets full JIT optimization.
