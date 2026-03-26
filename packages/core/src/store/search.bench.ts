/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

/**
 * Search performance benchmarks for the Store.
 *
 * Dataset: synthetic corpus of ~480 chunks across 8 topical "documents",
 * each chunk with a deterministic 768-dim embedding. Covers keyword,
 * vector, and hybrid search at multiple dataset sizes.
 *
 * Run:
 *   pnpm --filter @emdzej/ragclaw-core bench
 *
 * The first run after changes records a baseline; subsequent runs can be
 * compared by diffing the JSON output in benchmarks/results/.
 */

import { randomUUID } from "node:crypto";
import { afterAll, bench, describe } from "vitest";
import type { ChunkRecord } from "../types.js";
import { Store } from "./index.js";

// ---------------------------------------------------------------------------
// Synthetic corpus — 8 distinct topics, ~60 chunks each ≈ 480 total
// ---------------------------------------------------------------------------

const TOPICS: { source: string; paragraphs: string[] }[] = [
  {
    source: "/docs/authentication.md",
    paragraphs: [
      "OAuth 2.0 is an authorization framework that enables applications to obtain limited access to user accounts on HTTP services.",
      "JSON Web Tokens (JWT) are an open standard for securely transmitting information between parties as a compact, URL-safe token.",
      "Multi-factor authentication (MFA) adds an extra layer of security by requiring multiple forms of verification before granting access.",
      "Session management involves creating, maintaining, and invalidating user sessions to track authenticated state across HTTP requests.",
      "Password hashing algorithms like bcrypt, scrypt, and Argon2 protect stored credentials by making brute-force attacks computationally expensive.",
      "Single sign-on (SSO) allows users to authenticate once and gain access to multiple applications without re-entering credentials.",
      "Role-based access control (RBAC) restricts system access based on the roles assigned to individual users within an organization.",
      "API key authentication is a simple mechanism where a unique key is passed with each request to identify the calling application.",
      "Certificate-based authentication uses digital certificates issued by a trusted authority to verify client and server identities.",
      "OpenID Connect (OIDC) is an identity layer built on top of OAuth 2.0 that provides user authentication and profile information.",
    ],
  },
  {
    source: "/docs/database-design.md",
    paragraphs: [
      "Relational database normalization reduces data redundancy by organizing fields and tables to minimize dependency and eliminate anomalies.",
      "Database indexing strategies including B-tree, hash, and GIN indexes dramatically improve query performance for large datasets.",
      "ACID transactions guarantee atomicity, consistency, isolation, and durability for reliable database operations in concurrent environments.",
      "Query optimization involves analyzing execution plans, adding appropriate indexes, and restructuring queries to reduce response times.",
      "Database sharding distributes data across multiple servers to handle increased load and improve horizontal scalability.",
      "Connection pooling manages a cache of database connections that can be reused, reducing the overhead of establishing new connections.",
      "Schema migration tools like Flyway and Alembic manage incremental changes to database schema in a version-controlled manner.",
      "Full-text search indexes enable efficient text matching using inverted indexes, tokenization, and relevance ranking algorithms.",
      "Database replication creates copies of data across multiple servers for high availability, disaster recovery, and read scaling.",
      "Materialized views precompute and store query results, trading storage space for dramatically faster read performance on complex aggregations.",
    ],
  },
  {
    source: "/docs/react-patterns.md",
    paragraphs: [
      "React hooks like useState, useEffect, and useContext provide a way to use state and lifecycle features in functional components.",
      "The compound component pattern allows multiple components to work together to manage shared state without prop drilling.",
      "React Server Components (RSC) enable rendering components on the server, reducing JavaScript bundle size and improving initial load time.",
      "Memoization with React.memo, useMemo, and useCallback prevents unnecessary re-renders by caching computed values and callback references.",
      "The render props pattern shares code between components by using a prop whose value is a function that returns a React element.",
      "React Suspense provides a declarative way to handle loading states, allowing components to wait for asynchronous data before rendering.",
      "Custom hooks extract reusable stateful logic from components, enabling cleaner separation of concerns and better testability.",
      "Error boundaries catch JavaScript errors anywhere in the child component tree, log the errors, and display a fallback UI.",
      "The Context API provides a way to pass data through the component tree without manually passing props at every level.",
      "Concurrent rendering in React 18 enables interruptible rendering, allowing the browser to handle user interactions during long render cycles.",
    ],
  },
  {
    source: "/docs/kubernetes.md",
    paragraphs: [
      "Kubernetes pods are the smallest deployable units that can contain one or more containers sharing network and storage resources.",
      "Horizontal Pod Autoscaler (HPA) automatically scales the number of pod replicas based on observed CPU utilization or custom metrics.",
      "Kubernetes services provide stable networking endpoints for accessing pods, supporting ClusterIP, NodePort, and LoadBalancer types.",
      "ConfigMaps and Secrets allow you to decouple configuration from container images, making applications portable across environments.",
      "Kubernetes namespaces provide a mechanism for isolating groups of resources within a single cluster for multi-tenancy.",
      "Persistent volumes (PV) and persistent volume claims (PVC) abstract storage provisioning from pod lifecycle management.",
      "Kubernetes ingress controllers manage external access to services, providing load balancing, SSL termination, and name-based routing.",
      "Rolling updates in Kubernetes gradually replace pod instances with new ones, ensuring zero-downtime deployments.",
      "Resource quotas limit the total amount of CPU, memory, and storage that a namespace can consume in a cluster.",
      "Kubernetes operators extend the API to manage complex stateful applications using custom resources and controllers.",
    ],
  },
  {
    source: "/docs/machine-learning.md",
    paragraphs: [
      "Supervised learning algorithms train models on labeled datasets to predict outcomes for new, unseen data points.",
      "Neural network architectures like CNNs, RNNs, and Transformers learn hierarchical representations from raw input data.",
      "Gradient descent optimization iteratively adjusts model parameters to minimize the loss function during training.",
      "Feature engineering transforms raw data into informative features that improve model accuracy and generalization capability.",
      "Cross-validation techniques like k-fold split data into training and validation sets to assess model performance and prevent overfitting.",
      "Transfer learning leverages pre-trained models on large datasets and fine-tunes them for specific downstream tasks with limited data.",
      "Regularization methods like L1, L2, and dropout prevent overfitting by constraining model complexity during training.",
      "Hyperparameter tuning searches the configuration space for optimal learning rate, batch size, and architecture choices.",
      "Ensemble methods like random forests and gradient boosting combine multiple weak learners to produce stronger predictions.",
      "Model interpretability techniques like SHAP and LIME explain how features contribute to individual predictions.",
    ],
  },
  {
    source: "/docs/typescript-patterns.md",
    paragraphs: [
      "TypeScript generic types enable writing reusable components that work with multiple data types while maintaining full type safety.",
      "Discriminated unions use a literal type member to narrow union types, enabling exhaustive pattern matching with type guards.",
      "The TypeScript compiler performs structural typing, meaning compatibility is determined by the shape of types rather than their names.",
      "Conditional types like T extends U ? X : Y enable type-level programming by selecting types based on conditions.",
      "Mapped types transform properties of an existing type systematically, enabling utilities like Partial, Required, and Readonly.",
      "Template literal types allow string manipulation at the type level, enabling type-safe routing, event naming, and API definitions.",
      "The infer keyword in conditional types extracts constituent types from complex structures for use in type transformations.",
      "Type assertion functions narrow types at runtime while providing compile-time guarantees through the asserts return type.",
      "Module augmentation extends existing type declarations without modifying original source, useful for patching third-party libraries.",
      "Branded types create nominal type distinctions on top of structural types, preventing accidental mixing of semantically different values.",
    ],
  },
  {
    source: "/docs/ci-cd-pipelines.md",
    paragraphs: [
      "Continuous integration automatically builds and tests code changes whenever developers push commits to the shared repository.",
      "GitHub Actions workflows define automated pipelines using YAML configuration files triggered by repository events.",
      "Container-based CI runners provide isolated, reproducible build environments using Docker images with pre-installed dependencies.",
      "Artifact caching speeds up CI pipelines by storing and reusing dependencies, build outputs, and intermediate compilation results.",
      "Branch protection rules enforce code review, status checks, and merge requirements before changes reach the main branch.",
      "Blue-green deployments maintain two identical production environments, switching traffic between them for zero-downtime releases.",
      "Canary deployments gradually route a small percentage of traffic to the new version, monitoring for errors before full rollout.",
      "Infrastructure as code tools like Terraform and Pulumi define cloud resources declaratively for repeatable, version-controlled provisioning.",
      "Automated security scanning integrates SAST, DAST, and dependency vulnerability checks directly into the CI/CD pipeline.",
      "Feature flags decouple deployment from release, allowing teams to ship code changes behind toggles and enable them incrementally.",
    ],
  },
  {
    source: "/docs/performance-optimization.md",
    paragraphs: [
      "Profiling tools like Chrome DevTools and Node.js inspector identify CPU hotspots and memory leaks in running applications.",
      "Lazy loading defers the loading of non-critical resources until they are needed, improving initial page load times.",
      "Content delivery networks (CDNs) cache static assets at edge locations worldwide, reducing latency for geographically distributed users.",
      "Database query optimization includes proper indexing, query plan analysis, and denormalization for frequently accessed read-heavy data.",
      "Web Workers enable CPU-intensive computations to run in background threads without blocking the main UI thread.",
      "HTTP/2 multiplexing allows multiple requests and responses to share a single TCP connection, eliminating head-of-line blocking.",
      "Image optimization through compression, responsive formats like WebP/AVIF, and proper sizing reduces bandwidth usage significantly.",
      "Memory pool allocation reuses pre-allocated memory blocks to avoid garbage collection pauses in performance-critical applications.",
      "Debouncing and throttling limit the rate of function execution for frequently fired events like scroll, resize, and input.",
      "Server-side rendering (SSR) generates HTML on the server for faster first contentful paint and improved SEO crawlability.",
    ],
  },
];

/**
 * Expand each topic's paragraphs into ~60 chunks by adding numbered
 * variants. This gives us a corpus of ~480 chunks which is realistic
 * for a moderate-size knowledge base.
 */
function expandCorpus(): { source: string; text: string; index: number }[] {
  const corpus: { source: string; text: string; index: number }[] = [];
  let idx = 0;
  for (const topic of TOPICS) {
    for (const para of topic.paragraphs) {
      corpus.push({ source: topic.source, text: para, index: idx++ });
      for (let v = 1; v <= 5; v++) {
        corpus.push({
          source: topic.source,
          text: `${para} This section (part ${v}) provides further context and implementation details for production systems.`,
          index: idx++,
        });
      }
    }
  }
  return corpus;
}

/** Deterministic unit-normalised embedding for testing. */
function fakeEmbedding(seed: number, dim = 768): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed * (i + 1));
  }
  const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

// ---------------------------------------------------------------------------
// Pre-computed query embeddings
// ---------------------------------------------------------------------------

const queryEmbAuth = fakeEmbedding(0.5);
const queryEmbReact = fakeEmbedding(20.5);
const queryEmbML = fakeEmbedding(40.5);
const queryEmbCompound = fakeEmbedding(99.9);

// ---------------------------------------------------------------------------
// Eager setup — populate the store before any bench() runs.
// We use a module-level async IIFE that resolves to a ready Store.
// Each bench call awaits this promise (resolves instantly after first time).
// ---------------------------------------------------------------------------

const storeReady: Promise<Store> = (async () => {
  // Suppress sqlite-vec warning
  const origWarn = console.warn;
  console.warn = () => {};

  const store = new Store();
  await store.open(":memory:");

  const corpus = expandCorpus();
  const sourceIds = new Map<string, string>();
  for (const topic of TOPICS) {
    const id = await store.addSource({
      path: topic.source,
      type: "file",
      contentHash: randomUUID(),
      indexedAt: Date.now(),
    });
    sourceIds.set(topic.source, id);
  }

  const chunks: ChunkRecord[] = corpus.map((entry) => {
    const sourceId = sourceIds.get(entry.source);
    if (!sourceId) throw new Error(`Missing sourceId for ${entry.source}`);
    return {
      id: randomUUID(),
      sourceId,
      sourcePath: entry.source,
      text: entry.text,
      startLine: entry.index * 10,
      endLine: entry.index * 10 + 9,
      metadata: { type: "paragraph" as const },
      embedding: fakeEmbedding(entry.index),
      createdAt: Date.now(),
    };
  });

  const BATCH = 100;
  for (let i = 0; i < chunks.length; i += BATCH) {
    await store.addChunks(chunks.slice(i, i + BATCH));
  }

  console.warn = origWarn;
  return store;
})();

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

describe("search · 480 chunks · 8 topics", () => {
  afterAll(async () => {
    const store = await storeReady;
    await store.close();
  });

  // ─── Keyword search ─────────────────────────────────────────────────────

  bench("keyword · single term · 'authentication'", async () => {
    const store = await storeReady;
    await store.search({ text: "authentication", mode: "keyword", limit: 10 });
  });

  bench("keyword · two terms · 'neural network'", async () => {
    const store = await storeReady;
    await store.search({ text: "neural network", mode: "keyword", limit: 10 });
  });

  bench("keyword · compound · 'OAuth tokens and database sharding'", async () => {
    const store = await storeReady;
    await store.search({
      text: "OAuth tokens and database sharding",
      mode: "keyword",
      limit: 10,
    });
  });

  bench("keyword · broad · 'performance'", async () => {
    const store = await storeReady;
    await store.search({ text: "performance", mode: "keyword", limit: 10 });
  });

  bench("keyword · no matches · 'xyznonexistent'", async () => {
    const store = await storeReady;
    await store.search({ text: "xyznonexistent", mode: "keyword", limit: 10 });
  });

  bench("keyword · limit=50 · 'deployment'", async () => {
    const store = await storeReady;
    await store.search({ text: "deployment", mode: "keyword", limit: 50 });
  });

  // ─── Vector search (JS fallback — no sqlite-vec in test env) ────────────

  bench("vector · close match · limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "",
      embedding: queryEmbAuth,
      mode: "vector",
      limit: 10,
    });
  });

  bench("vector · mid-range · limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "",
      embedding: queryEmbReact,
      mode: "vector",
      limit: 10,
    });
  });

  bench("vector · limit=50", async () => {
    const store = await storeReady;
    await store.search({
      text: "",
      embedding: queryEmbML,
      mode: "vector",
      limit: 50,
    });
  });

  // ─── Hybrid search (deferred hydration + RRF) ──────────────────────────

  bench("hybrid · single topic · 'authentication' limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "authentication",
      embedding: queryEmbAuth,
      mode: "hybrid",
      limit: 10,
    });
  });

  bench("hybrid · two terms · 'React hooks' limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "React hooks",
      embedding: queryEmbReact,
      mode: "hybrid",
      limit: 10,
    });
  });

  bench("hybrid · compound · 'OAuth tokens and database sharding' limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "OAuth tokens and database sharding",
      embedding: queryEmbCompound,
      mode: "hybrid",
      limit: 10,
    });
  });

  bench("hybrid · broad · 'performance optimization' limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "performance optimization",
      embedding: queryEmbML,
      mode: "hybrid",
      limit: 10,
    });
  });

  bench("hybrid · limit=50 · 'TypeScript patterns'", async () => {
    const store = await storeReady;
    await store.search({
      text: "TypeScript patterns",
      embedding: queryEmbReact,
      mode: "hybrid",
      limit: 50,
    });
  });

  bench("hybrid · no keyword hits · 'xyznonexistent' limit=10", async () => {
    const store = await storeReady;
    await store.search({
      text: "xyznonexistent",
      embedding: queryEmbCompound,
      mode: "hybrid",
      limit: 10,
    });
  });
});
