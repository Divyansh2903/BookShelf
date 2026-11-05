# AI Terminology Explained

<<<SECTION 1>>>
## Rules vs Machine Learning

Traditional software follows rules a developer writes ("if this, then that") exactly, and never improves on its own.

Machine learning instead learns patterns from examples (data). The more relevant data it sees, the better it predicts or generates outputs, without a human hardcoding every case.

## Transformers

The architecture behind almost every major AI model today (GPT, Claude, Gemini, etc.). Earlier models processed text word by word in order, which made long-range context hard.

Transformers introduced **attention**: the model looks at all words in a sentence or document at once and works out which matter most to each other. This lets it understand context like "it" referring to something five sentences earlier.

## LLMs (Large Language Models)

A transformer-based model trained on massive amounts of text to predict the next word (technically the next **token**). Done well at large scale, the model can write, reason, summarize, and answer questions in ways that feel intelligent.

GPT, Claude, and Llama are LLMs. "Large" refers to the number of **parameters** (internal values tuned during training), often in the billions.

<<<SECTION 2>>>
## Temperature and Context Window

- **Temperature** controls output randomness. Low (close to 0): more predictable and focused. High: more creative and varied, but more likely to go off the rails.
- **Context window** is how much text the model can "see" at once, in tokens. A 128k token window is roughly how much text (conversation, documents, code, etc.) it can consider before forgetting the earliest parts.

## Chatbots vs AI Agents

A **chatbot** answers questions and only generates text; it can't take actions in the world.

An **AI agent** takes actions (calling APIs, running code, searching the web, updating a database) and uses the results to decide what to do next. A chatbot talks; an agent acts.

## Agent Loop

The repeating cycle an agent runs to complete a task:

1. Observe (current state or input)
2. Think (decide what to do next)
3. Act (call a tool or take an action)
4. Observe the result
5. Repeat until done

This turns a single LLM call into something that handles multi-step, real-world tasks.

## ReAct Pattern

"Reasoning and Acting": a prompting pattern where the model explicitly reasons in text (Thought), picks an action (Action), sees the result (Observation), and repeats.

It makes decision-making visible rather than a black box, and generally improves accuracy on multi-step tasks because the model must "think out loud" before acting.

## Tools

Functions or APIs a model can call to do what it can't alone: web search, running code, querying a database, sending email. The model doesn't execute the tool; it chooses the tool and inputs, and the surrounding system runs it and returns the result.

This turns an LLM from "just text generation" into something that interacts with real systems.

## AI Memory (and Amnesia)

By default LLMs have no memory between conversations ("AI amnesia"): every chat starts from zero, with no recall of your name, preferences, or yesterday unless fed back into the prompt.

**AI memory** is a system built on top of the model that stores facts about a user or task and retrieves and injects relevant ones into future conversations, so the model behaves as if it remembers.

<<<SECTION 3>>>
## RAG (Retrieval-Augmented Generation)

LLMs know only their training data, which has a cutoff date. RAG pulls in fresh, relevant information at query time.

How it works: documents or data are split into chunks and stored (usually in a vector database). For each question, the system retrieves the most relevant chunks and feeds them into the model's context, so it answers with current, specific information rather than only what it memorized in training.

## MCP (Model Context Protocol)

A standard way for AI models to connect to external tools and data sources (Salesforce, GitHub, a file system) without a custom integration for each.

Like a universal adapter: instead of bespoke code for every new service, MCP defines a common protocol so any compliant tool plugs into any compliant model.

## Smart Agent Architectures

How a single agent is structured internally to make good decisions rather than react blindly. Typically includes:

- A planning layer (breaking a big task into smaller steps)
- Memory (short-term and long-term)
- Tool access
- A reasoning loop (like ReAct) to decide the next step

The goal is an agent that handles ambiguity, recovers from errors, and adjusts its plan mid-task instead of following a rigid script.

<<<SECTION 4>>>
## Multi-Agent Architectures

Work is split across several specialized, collaborating agents instead of one doing everything. E.g. one plans, one writes code, one reviews it, one communicates with the user.

Like human teams, specialization improves quality, and a coordinator (an **orchestrator agent**) manages handoffs.

**A few more worth knowing**

- **Embeddings**: numerical representations of text (or images) capturing meaning, so similar concepts are mathematically close. The foundation of RAG and semantic search.
- **Vector database**: stores embeddings and searches them by similarity rather than exact keyword match.
- **Fine-tuning**: further training a pre-trained model on a smaller, specific dataset to improve it at a task or domain.
- **Hallucination**: the model confidently generates false or made-up information, because it predicts plausible text rather than looking up facts, unless grounded with something like RAG.
- **Prompt engineering**: carefully crafting inputs (prompts) to get better, more reliable outputs.
- **Guardrails**: rules or filters around a model's inputs and outputs to keep it safe, on-topic, and within acceptable bounds.
