# AI Terminology Explained

<<<SECTION 1>>>
## Rules vs Machine Learning

Traditional software runs on rules. A developer writes "if this, then that," and the program follows it exactly. It never improves on its own.

Machine learning flips this. Instead of writing rules, you feed the system examples (data), and it learns the patterns itself. The more relevant data it sees, the better it gets at predicting or generating outputs, without a human hardcoding every case.

## Transformers

Transformers are the architecture behind almost every major AI model today (GPT, Claude, Gemini, and so on). Before transformers, models processed text word by word in order, which made it hard to understand long-range context.

Transformers introduced a mechanism called "attention," which lets the model look at all the words in a sentence (or document) at once and figure out which ones matter most to each other. This is what allows models to understand context like "it" referring to something mentioned five sentences earlier.

## LLMs (Large Language Models)

An LLM is a transformer-based model trained on massive amounts of text so it can predict the next word (technically, the next "token") in a sequence. Do this well enough, at a large enough scale, and the model starts to write, reason, summarize, and answer questions in ways that feel intelligent.

GPT, Claude, and Llama are all LLMs. "Large" refers to the number of parameters (the internal values the model tunes during training), often in the billions.

<<<SECTION 2>>>
## Temperature and Context Window

Two settings you will run into constantly:

**Temperature** controls randomness in the output. Low temperature (close to 0) makes the model more predictable and focused. High temperature makes it more creative and varied, but also more likely to go off the rails.

**Context window** is how much text the model can "see" at once, measured in tokens. If a model has a 128k token context window, that is roughly the amount of text (your conversation, documents, code, etc.) it can consider before it starts forgetting the earliest parts.

## Chatbots vs AI Agents

A chatbot answers questions. You ask, it responds, conversation over. It has no memory of taking actions in the world and no ability to actually do anything beyond generating text.

An AI agent goes further. It can take actions: calling APIs, running code, searching the web, updating a database, and then use the results of those actions to decide what to do next. The core difference is that a chatbot talks, an agent acts.

## Agent Loop

The agent loop is the repeating cycle an AI agent runs through to complete a task:

1. Observe (look at the current state or input)
1. Think (decide what to do next)
1. Act (call a tool or take an action)
1. Observe the result
1. Repeat until the task is done

This loop is what turns a single LLM call into something that can handle multi-step, real-world tasks.

## ReAct Pattern

ReAct stands for "Reasoning and Acting." It is a prompting pattern where the model is asked to explicitly reason through a problem in text (Thought), decide on an action (Action), see the result (Observation), and repeat.

This makes the model's decision-making visible instead of a black box, and it generally improves accuracy on multi-step tasks because the model is forced to "think out loud" before acting.

## Tools

Tools are functions or APIs that an AI model can call to do things it cannot do on its own, like searching the web, running code, querying a database, or sending an email. The model does not execute the tool itself; it decides which tool to use and with what inputs, and the surrounding system actually runs it and returns the result.

This is the mechanism that turns an LLM from "just text generation" into something that can interact with real systems.

## AI Memory (and Amnesia)

By default, LLMs have no memory between conversations. Every new chat starts from zero, this is often called "AI amnesia." The model does not remember your name, your preferences, or anything from yesterday unless that information is explicitly fed back into the prompt.

AI memory refers to systems built on top of the model to solve this: storing facts about a user or task, then retrieving and injecting the relevant ones into future conversations so the model behaves as if it "remembers."

<<<SECTION 3>>>
## RAG (Retrieval-Augmented Generation)

LLMs only know what they were trained on, and their training data has a cutoff date. RAG solves this by letting the model pull in fresh, relevant information at the time of the query.

Here's how it works: your documents or data are broken into chunks and stored (usually in a vector database). When a question comes in, the system retrieves the most relevant chunks and feeds them into the model's context, so it can answer using current, specific information instead of relying purely on what it memorized during training.

## MCP (Model Context Protocol)

MCP is a standardized way for AI models to connect to external tools and data sources, like Salesforce, GitHub, or a file system, without needing a custom integration built for every single one.

Think of it like a universal adapter. Instead of writing bespoke code every time you want a model to talk to a new service, MCP defines a common protocol so any compliant tool can plug into any compliant model.

## Smart Agent Architectures

This refers to how an individual agent is structured internally to make good decisions, not just react blindly. It typically includes:

- A planning layer (breaking a big task into smaller steps)
- Memory (short-term and long-term)
- Tool access
- A reasoning loop (like ReAct) to decide what to do next

A "smart" agent architecture is designed so the agent can handle ambiguity, recover from errors, and adjust its plan mid-task, rather than following a rigid script.

<<<SECTION 4>>>
## Multi-Agent Architectures

Instead of one agent trying to do everything, multi-agent architectures split work across several specialized agents that collaborate. For example, one agent might plan, another might write code, another might review it, and another might handle communication with the user.

This mirrors how human teams work: specialization improves quality, and a coordinator (sometimes called an "orchestrator agent") manages handoffs between them.

A Few More Worth Knowing

**Embeddings**: numerical representations of text (or images) that capture meaning, so similar concepts end up close together mathematically. This is the foundation that makes RAG and semantic search possible.

**Vector database**: a database built specifically to store embeddings and search them by similarity, instead of exact keyword matches.

**Fine-tuning**: taking a pre-trained model and training it further on a smaller, specific dataset so it gets better at a particular task or domain.

**Hallucination**: when a model confidently generates information that is false or made up. This happens because the model is predicting plausible text, not looking up facts, unless it's explicitly grounded with something like RAG.

**Prompt engineering**: the practice of crafting inputs (prompts) carefully to get better, more reliable outputs from a model.

**Guardrails**: rules or filters put around a model's inputs and outputs to keep it safe, on-topic, and within acceptable bounds.

That's all, folks...Cheers!!
