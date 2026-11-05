# Divyansh Book Shelf

A private, offline reading app for long-form engineering articles, bound as three books:

| Book | Parts | Chapters |
|---|---|---|
| System Design | Fundamentals · High-Level Design · Low-Level Design · Distributed Systems | 48 |
| Backend | Backend Fundamentals · Microservices · Under the Hood · Miscellany | 19 |
| AI & Machine Learning | AI and ML Foundations · Building with Claude | 4 |

Everything is in one file, `Bookshelf.html`: text, diagrams, fonts and code. It never loads anything from the network, so it works on a plane.

## Reading

- **Shelf.** Pick a book. Each shows chapter count, progress, and a Continue link once you have started it.
- **Full and Short.** Every chapter has the original text (default) and a condensed version with the same facts and all code kept. Switching keeps your place.
- **Your place is saved** down to the paragraph as you read. Reopen the app and continue from the shelf; the paragraph you stopped at is highlighted.
- **Bookmarks.** The ribbon marks the paragraph at the top of the screen, with an optional note. One list across all books.
- **Text.** Size and night paper under "Aa".
- **Reset.** At the bottom of each book page, clears that book's progress and bookmarks.
- Arrow keys move between chapters.

Progress and bookmarks live in the browser's local storage on the device you read on.

## Deploying

The app is static. Serve `Bookshelf.html` as the index page of any static host (GitHub Pages, Netlify, Vercel, an S3 bucket) or just open the file locally.

```
npm install
npm run build        # writes Bookshelf.html
```

`npm run dev` starts a live preview while editing.

## Project layout

```
Bookshelf.html         the built app
books/<slug>/          one folder per book
  meta.json            title, cloth colour, shelf order, parts, chapter order, image list
  original/<id>.md     the article as published
  condensed/<id>.md    the short version
  images/<id>/         cover and diagrams
scripts/build-data.mjs renders markdown to HTML and bundles the books
src/                   React app (Vite, single-file build)
```

### Adding a book

1. Create `books/<slug>/` with the structure above.
2. Chapter files are split with `<<<SECTION n>>>` markers (the app joins them back into one article). Diagrams are referenced as `{{IMG:n}}` placeholders mapped in `meta.json`.
3. Set `order` in `meta.json` for its place on the shelf.
4. `npm run build`.

## Credits

All articles were written by **Harshit Khosla** and are reproduced here for personal reading only. The words, diagrams and code belong to the author.

- Author on X: [@Harry_The_Nerd](https://x.com/Harry_The_Nerd)
- Learning paths and article index: [vidya-bodha.com](https://www.vidya-bodha.com/)
- Learning paths used for the book structure: [System Design Fundamentals](https://vidya-bodha.com/paths/system-design-fundamentals), [HLD Interview Prep](https://vidya-bodha.com/paths/hld-interview-prep), [LLD Classics](https://vidya-bodha.com/paths/lld-classics), [Distributed Systems](https://vidya-bodha.com/paths/distributed-systems), [Backend Engineering Fundamentals](https://vidya-bodha.com/paths/backend-engineering-fundamentals), [Microservices](https://vidya-bodha.com/paths/microservices), [AI and ML Foundations](https://vidya-bodha.com/paths/ai-and-ml-foundations)

The Short versions were condensed from the originals; they keep every fact, number and code block but cut filler. Any mistakes introduced there are mine, not the author's.

<details>
<summary>Every chapter with a link to the original post</summary>

**System Design**

- [System Design for Beginners: How to Start With HLD and LLD](https://x.com/Harry_The_Nerd/status/2099048223797043656)
- [Design a Load Balancer](https://x.com/Harry_The_Nerd/status/2046465659551576395)
- [Design a Content Delivery Network](https://x.com/Harry_The_Nerd/status/2046578404758295032)
- [Design Consistent Hashing](https://x.com/Harry_The_Nerd/status/2057098732328648808)
- [Design A Unique ID Generator in Distributed Systems](https://x.com/Harry_The_Nerd/status/2057461354114728238)
- [Design A Distributed Cache](https://x.com/Harry_The_Nerd/status/2048052028174463278)
- [A Complete Guide to Redis](https://x.com/Harry_The_Nerd/status/2061076806552392055)
- [Design a Distributed Key-Value store](https://x.com/Harry_The_Nerd/status/2047329176982827353)
- [Design A Rate Limiter](https://x.com/Harry_The_Nerd/status/2045533839649624096)
- [Apache Kafka: Crash Course](https://x.com/Harry_The_Nerd/status/2062165677033820383)
- [Design A Distributed Message Queue](https://x.com/Harry_The_Nerd/status/2106418481130516785)
- [Design an Authentication System](https://x.com/Harry_The_Nerd/status/2048758919770816850)
- [Design A Notification System](https://x.com/Harry_The_Nerd/status/2044839667267494292)
- [Tricky HLD Patterns for interviews](https://x.com/Harry_The_Nerd/status/2056739488114856226)
- [Design Bit.ly and Pastebin](https://x.com/Harry_The_Nerd/status/2044672371546877964)
- [Design Autocomplete For Search Engines](https://x.com/Harry_The_Nerd/status/2045906641967833171)
- [Design A News-Feed System](https://x.com/Harry_The_Nerd/status/2058553384735842654)
- [Design A Chat System](https://x.com/Harry_The_Nerd/status/2061445321910284589)
- [Design Twitter](https://x.com/Harry_The_Nerd/status/2068309801638195531)
- [Design Instagram](https://x.com/Harry_The_Nerd/status/2065074213665579192)
- [Design Reddit](https://x.com/Harry_The_Nerd/status/2067615247259811850)
- [Design Tinder](https://x.com/Harry_The_Nerd/status/2065790968448909572)
- [System Design Of A Proximity Service](https://x.com/Harry_The_Nerd/status/2091192716059459825)
- [Design Youtube](https://x.com/Harry_The_Nerd/status/2062909779576791167)
- [Design Spotify](https://x.com/Harry_The_Nerd/status/2063952850531897396)
- [Design Netflix](https://x.com/Harry_The_Nerd/status/2071256571028648283)
- [Design Medium](https://x.com/Harry_The_Nerd/status/2084263186199638124)
- [Design Leetcode](https://x.com/Harry_The_Nerd/status/2083591314067927258)
- [Design Amazon](https://x.com/Harry_The_Nerd/status/2070543086258979132)
- [Design Airbnb](https://x.com/Harry_The_Nerd/status/2079561027788611975)
- [Design Google Drive](https://x.com/Harry_The_Nerd/status/2088619948113641872)
- [Design Google Docs](https://x.com/Harry_The_Nerd/status/2087149020011774260)
- [Design Google Maps](https://x.com/Harry_The_Nerd/status/2101675662482571673)
- [Design Discord](https://x.com/Harry_The_Nerd/status/2114362276316942758)
- [Design A Metrics Monitoring and Alerting System](https://x.com/Harry_The_Nerd/status/2108858835440119870)
- [LLD Concepts](https://x.com/Harry_The_Nerd/status/2055635966568620167)
- [Design a Parking Lot](https://x.com/Harry_The_Nerd/status/2057821348450402614)
- [Design a Vending Machine](https://x.com/Harry_The_Nerd/status/2060348729929175403)
- [Design a basic Music System](https://x.com/Harry_The_Nerd/status/2056620076246479055)
- [Design Youtube](https://x.com/Harry_The_Nerd/status/2060001018134553006)
- [Distributed Systems Part-1 (Introduction)](https://x.com/Harry_The_Nerd/status/2092234002610680246)
- [Distributed Systems Part-2 (Time, Order, and Causality)](https://x.com/Harry_The_Nerd/status/2092969096774287363)
- [Distributed Systems Part-3 (Replication Strategies)](https://x.com/Harry_The_Nerd/status/2093700736299487430)
- [Distributed Systems Part-4 (Consistency Models)](https://x.com/Harry_The_Nerd/status/2094422311906726202)
- [Distributed Systems Part-5 (Consensus Algorithms)](https://x.com/Harry_The_Nerd/status/2095122732065443969)
- [Distributed Systems Part-6 (Partitioning and Sharding)](https://x.com/Harry_The_Nerd/status/2095844630399263161)
- [Distributed Systems Part-7 (Failure Detection and Fault Tolerance)](https://x.com/Harry_The_Nerd/status/2096163179596525852)
- [Distributed Systems Part-8 (Distributed Transactions Revisited)](https://x.com/Harry_The_Nerd/status/2096575304722747738)

**Backend**

- [HTTP & Routing](https://x.com/Harry_The_Nerd/status/2053366145995178087)
- [Serialization, Deserialization, Authentication and Authorization](https://x.com/Harry_The_Nerd/status/2053487726033559704)
- [Validation, Transformation, Controllers, Middlewares](https://x.com/Harry_The_Nerd/status/2053882356071911853)
- [Rest API Design](https://x.com/Harry_The_Nerd/status/2054882198604628305)
- [Databases in Depth Part-1](https://x.com/Harry_The_Nerd/status/2073772366094602241)
- [Databases in Depth Part-2](https://x.com/Harry_The_Nerd/status/2075942037732667812)
- [Databases in Depth Part-3](https://x.com/Harry_The_Nerd/status/2076649413435687097)
- [Caching, Task Queues, Error Handling, Logging, Monitoring](https://x.com/Harry_The_Nerd/status/2077400118647750968)
- [Security, Scaling & Performance, Concurrency & Parallelism](https://x.com/Harry_The_Nerd/status/2077722979882963122)
- [Mental Model for Microservices](https://x.com/Harry_The_Nerd/status/2080261902593065465)
- [Monolith To Microservices](https://x.com/Harry_The_Nerd/status/2080659276998291721)
- [Service Decomposition And Boundaries](https://x.com/Harry_The_Nerd/status/2080943768153596085)
- [Inter-Service Communication](https://x.com/Harry_The_Nerd/status/2081302031646806047)
- [Data Ownership And Read Models](https://x.com/Harry_The_Nerd/status/2081673770092433631)
- [Distributed Transactions, Sagas, and Consistency](https://x.com/Harry_The_Nerd/status/2082019622224900154)
- [How JavaScript Executes The Code - Behind The Scenes](https://x.com/Harry_The_Nerd/status/2075158256826335454)
- [Python's Inner Working - Behind The Scenes](https://x.com/Harry_The_Nerd/status/2078116519029129646)
- [AWS Certified Solutions Architect - Associate SAA-C03 Exam Tricks](https://x.com/Harry_The_Nerd/status/2066793644783513735)
- [How To Get Started With Writing- Technical and Creative](https://x.com/Harry_The_Nerd/status/2072219094728978564)

**AI & Machine Learning**

- [AI Terminology Explained](https://x.com/Harry_The_Nerd/status/2087837722098700421)
- [Everything About Machine Learning](https://x.com/Harry_The_Nerd/status/2086085446300533025)
- [Netflix Recommendation System - Machine Learning System Design](https://x.com/Harry_The_Nerd/status/2069785739810705773)
- [A Complete Guide For Claude Certified Architect Foundations (CCA-F) Exam](https://x.com/Harry_The_Nerd/status/2069050669487809004)
</details>

## Built with

React, Vite, vite-plugin-singlefile, markdown-it, highlight.js. Type is EB Garamond and Courier Prime.
