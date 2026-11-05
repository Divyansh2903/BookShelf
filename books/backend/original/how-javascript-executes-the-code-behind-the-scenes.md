# How JavaScript Executes The Code - Behind The Scenes

<<<SECTION 1>>>
JavaScript looks simple on the surface. You write some code, hit run, and it works. But under the hood, there is a whole pipeline of steps that turn your readable source code into machine instructions the CPU can actually execute. Let's break this down stage by stage, folks.. the way V8 (the engine that powers Chrome and Node.js) does it.

## Stage 1: The Source Code

Everything starts with your **.js** file. This is just plain text sitting on disk. The engine's job is to take this text and turn it into something the machine understands. This happens in several phases, and none of it is a single "compile everything at once" step. JavaScript engines are smart about doing just enough work at just the right time.

## Stage 2: Lexical Analysis (Tokenizing)

Before anything else, the engine reads your raw text character by character and breaks it into small chunks called tokens. This process is called tokenizing or lexical analysis.

For example, this line:

```javascript
let x = 10 + 5;
```

gets broken into tokens like:

let, x, =, 10, +, 5, ;

Each token has a type (keyword, identifier, number, operator, punctuation) and a value. The tokenizer does not care about meaning yet, it just chops the text into meaningful pieces and throws away things like extra whitespace and comments.

<<<SECTION 2>>>
## Stage 3: Parsing and the Abstract Syntax Tree (AST)

Once you have tokens, the engine needs to understand the structure and grammar of your code. This is where the parser comes in.

The parser takes the flat list of tokens and builds a tree structure called the Abstract Syntax Tree (AST). This tree represents the grammatical structure of your program. So let x = 10 + 5; becomes something like:

{{IMG:1}}

Every statement, expression, and declaration in your code becomes a node in this tree. This is the same idea used by tools like Babel and ESLint, they all work by generating and walking an AST.

V8 actually does this in two passes for performance reasons. First it does a quick "pre-parse" that just scans function bodies without fully parsing them (skipping functions that are not called immediately, since parsing is expensive and many functions never run). Then it does a full parse only when a function is actually about to be executed. This is called lazy parsing and it is one of the reasons JS engines start up fast even for huge codebases.

<<<SECTION 3>>>
## Stage 4: From AST to Bytecode

Here is where most people get confused, because they think JS just gets interpreted line by line from the AST directly. Modern engines do not do that. Interpreting a tree directly is slow because you have to walk pointers and check node types constantly.

Instead, V8 has a component called Ignition, which is the interpreter. Ignition takes the AST and compiles it into a simpler, more compact form called bytecode.

Bytecode is not machine code. It is a lower level, engine specific instruction set, something like an intermediate language between your JS code and actual CPU instructions. Bytecode instructions look like:

LdaSmi \[10\]  
Star r0  
LdaSmi \[5\]  
Add r0

These are small, generic instructions like "load a value," "add two registers," "store into a variable." This bytecode is compact, quick to generate, and quick to start executing. This is why JS can start running almost immediately instead of waiting for a full, heavy compilation like C++ does.

<<<SECTION 4>>>
## Stage 5: Interpretation Begins

Ignition starts executing this bytecode right away using an interpreter loop. This gets your code running fast, but interpreted execution is not the fastest way to run code long term, since every instruction has some overhead of being interpreted one at a time.

While it interprets, the engine also does something clever: it collects information about your code as it runs. This is called profiling or gathering type feedback. It watches things like:

- What types of values are actually flowing into a function (numbers, strings, objects)
- Which functions are called repeatedly (hot functions)
- What shapes objects have (their properties and structure)

This information becomes very important in the next stage.

## Stage 6: The JIT Compiler Kicks In

JIT stands for Just In Time compilation. This is the real performance secret of modern JS engines. Instead of compiling everything to machine code upfront (which would be slow to start and wasteful for code that runs only once), the engine waits and watches.

If a function gets called many times (V8 calls these "hot functions"), the engine decides it is worth spending extra effort to optimize it. This is where V8's optimizing compiler, called TurboFan, steps in.

TurboFan takes the bytecode plus all the type feedback collected earlier, and compiles that hot function directly into highly optimized machine code, the actual binary instructions your CPU runs natively. No more interpreting step by step, the CPU just executes it directly.

This optimized machine code is much faster because it can make assumptions based on what it observed. For example, if a function always received numbers as arguments, TurboFan can generate machine code that skips all the extra type checking JS normally needs, and just does raw number math.

<<<SECTION 5>>>
## Stage 7: Deoptimization (The Safety Net)

Here is the catch. JavaScript is dynamically typed, so those assumptions the JIT compiler made could turn out to be wrong later. Suppose a function was optimized assuming it always gets numbers, but then someone calls it with a string.

When this happens, the engine cannot keep running the optimized machine code because it would produce wrong results. So it throws away that optimized version and falls back to the slower bytecode interpreter again. This is called deoptimization or "bailing out."

If the function later stabilizes back to consistent types, it can get re-optimized again. This is why writing consistent, predictable code (same types, same object shapes) generally runs faster in JS, it lets the JIT compiler stay confident in its optimizations instead of constantly bailing out.

## Stage 8: Hidden Classes and Inline Caching

Two more concepts make this whole system fast:

**Hidden classes:** JS objects do not have fixed structures like classes in Java or C++. But under the hood, V8 secretly assigns hidden classes (also called "shapes") to objects based on their property structure. Two objects with the same properties in the same order share a hidden class. This lets the engine treat JS objects almost like structs with fixed layouts, which is much faster than looking up properties in a hash map every time.

**Inline caching:** When the engine repeatedly sees the same operation, like accessing [obj.name](https://x.com//obj.name), it caches the location of that property based on the hidden class, so next time it can jump straight to the memory location instead of doing a full lookup. This is a huge speed boost for repeated property access, which is extremely common in JS code.

<<<SECTION 6>>>
## Putting It All Together

Here is the full pipeline in order:

Source code (.js file)  
   -> Tokenizer (lexical analysis, produces tokens)  
   -> Parser (produces Abstract Syntax Tree)  
   -> Ignition (compiles AST to bytecode, interprets it)  
   -> Profiler (collects type feedback while running)  
   -> TurboFan (JIT compiles hot bytecode into optimized machine code)  
   -> CPU executes machine code directly  
   -> (if assumptions break) Deoptimize back to bytecode

This whole system exists because of a tradeoff. Pure interpreters are slow to run but fast to start. Pure compilers are fast to run but slow to start (since they need to fully compile before executing anything). JS engines get the best of both worlds by starting with an interpreter for instant execution, then upgrading hot code paths to compiled machine code on the fly, while keeping the ability to fall back if their optimizations turn out to be wrong.

This is also why microbenchmarks in JS can be misleading. Code run only once behaves very differently from code run in a tight loop thousands of times, because the second case gets the full benefit of JIT optimization while the first one never leaves the interpreter.

That's all, folks..Cheers!!
