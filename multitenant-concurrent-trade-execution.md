# Executive Summary

Building a robust, concurrent, multi-tenant trade execution system for the Polymarket CLOB API requires a multi-faceted approach centered on isolation, fairness, and resilience. The key strategy involves implementing a two-tier rate-limiting system: a global limiter that respects Polymarket's API caps (e.g., 3,500 POST /order requests per 10 seconds) and a per-tenant fair-sharing scheduler, such as Deficit Round Robin (DRR), to prevent any single tenant from starving others. To guarantee exactly-once trade execution and prevent duplicate orders during retries or concurrent copy-trading, the system must adopt a strict idempotency model, similar to Stripe's, using unique keys for all mutating API calls. Tenant isolation is paramount and is achieved by using per-tenant job queues, in-flight request deduplication guards, and independent circuit breakers, ensuring that one tenant's errors or high volume do not impact others. The architecture should be built on a non-blocking Node.js foundation, leveraging modern HTTP clients like `undici` for efficient connection pooling and keep-alive. Finally, the system must manage the Polymarket heartbeat to maintain session liveness and prevent the automatic cancellation of all open orders.

# Solution Architecture Overview

The proposed solution architecture consists of several key components designed to work together to provide a scalable, fair, and resilient multi-tenant trading system. At its core is an **Intent Store**, implemented using SQLite in WAL (Write-Ahead Logging) mode for improved concurrency. This store includes an idempotency table that records request keys, parameters, status, and responses, guaranteeing exactly-once semantics and preventing duplicate operations. Trade requests are first placed into **Per-tenant Work Queues**, which isolates each tenant's workload. These queues are augmented with in-memory 'singleflight'-style guards to deduplicate identical, concurrent in-flight requests from the same tenant, a common issue in copy-trading scenarios. A central **Global Scheduler and Dispatcher** pulls jobs from the tenant queues. This component implements a fair queuing algorithm like Deficit Round Robin (DRR) to allocate the shared Polymarket API rate limit equitably among active tenants. It manages a global token bucket reflecting Polymarket's endpoint limits and handles request retries with exponential backoff and jitter upon receiving 429 (Too Many Requests) errors. Finally, all communication with the Polymarket API is routed through a shared, long-lived **Polymarket Client**. This client is built using `undici` to leverage efficient connection pooling, keep-alive, and pipelining, minimizing the overhead of creating new connections for each request.

# Strategy For Race Conditions And Deduplication

## In Memory Deduplication Strategy

The system should adopt a Stripe-style idempotency model for all mutating API calls. This involves generating a unique idempotency key for each request and storing a record of the request hash, its parameters, the resulting response, and its status for a specific time-to-live (TTL) window (e.g., 24 hours). When a request with a previously used key is received, the system compares the parameters to the original request. If they match, it returns the saved response, including any errors, without re-executing the operation. This guarantees exactly-once semantics, preventing duplicate orders even when facing network retries or duplicate triggers. For Polymarket specifically, a client-side unique `nonce` should be part of the order intent to further ensure uniqueness.

## Single Flight Pattern Usage

To prevent race conditions from simultaneous identical requests, such as in a copy-trading burst, a 'single-flight' pattern should be implemented. This involves maintaining in-memory guards keyed by a unique operation identifier (e.g., a combination of tenant ID, market ID, side, and price band). When a request for an operation arrives, the system checks if a job for that key is already in-flight. If so, subsequent duplicate requests do not trigger new API calls but are instead coalesced to await the result of the single active job. This ensures only one API request is active for any unique trade attempt at a given moment, conserving resources and preventing duplicate submissions.

## Deduplication Key Strategy

A multi-faceted keying strategy is used for deduplication. For general idempotency (Stripe-style), keys are composed of stable, unique fields such as `tenant_id`, `market_id`, an `order_intent_hash`, and a timestamp bucket. For handling in-flight race conditions with the single-flight pattern, a more specific key is used, such as `(tenant_id, market_id, side, price band)`. Furthermore, when creating orders on Polymarket, it is recommended to use the API's `nonce` parameter by defining a client-side unique nonce for each order intent and including it in the idempotency key computation to provide an additional layer of uniqueness.


# Strategy For Managing Shared Api Rate Limits

## Centralized Dispatcher Design

The proposed design features a centralized, two-tier limiter system managed by a core scheduler or dispatcher. This central component is responsible for orchestrating all outgoing requests to the Polymarket API. It consists of a 'Global Limiter' that enforces the overall API rate caps (e.g., 3,500 requests per 10 seconds) and a 'Per-tenant Limiter' that manages fair access for each user. A background dispatcher works by pulling trade intents from durable per-tenant outboxes (queues) and feeding them through the scheduler, which then makes the final decision on when to send the request based on available capacity and fairness rules.

## Per Tenant Queue Model

To ensure tenant isolation and prevent a busy tenant from blocking others (head-of-line blocking), the strategy mandates the use of dedicated FIFO (First-In, First-Out) queues for each tenant. These queues hold the trading intents for each user separately. For more granular control, these queues can be further organized into priority classes, such as giving urgent cancellation requests higher priority than new passive order placements. This model guarantees that each tenant's workload is processed independently, and issues or high volume from one tenant will not directly impact the trade execution of others.

## Global Limit Tracking Method

The dispatcher tracks usage against the global API rate limit using a 'Global Limiter,' which is implemented as a token bucket or leaky bucket algorithm for each specific API endpoint and its corresponding time window. This limiter is configured with the official rate limits published by Polymarket (e.g., 3,500 req/10s for `POST /order`). As the central scheduler dispatches requests from tenant queues, it consumes tokens from this global bucket. This mechanism ensures that the total volume of requests sent from the entire system never exceeds the allowed cap, thus avoiding API throttling (HTTP 429 errors) from Polymarket's servers.


# Fair Queuing And Throttling Implementation

## Chosen Algorithm

The recommended fair queuing algorithm is Deficit Round Robin (DRR). As an alternative, 2D Fair Queuing is also mentioned. DRR is selected for its proven ability to provide fair bandwidth allocation among multiple queues competing for a single shared resource, which in this case is the Polymarket API rate limit.

## Algorithm Description

The DRR algorithm is implemented by a central scheduler that services the per-tenant queues. In each cycle, every tenant is allocated a 'quantum' (a budget of requests). The scheduler processes requests from each tenant's queue in a round-robin fashion, decrementing their quantum for each request sent. Once a tenant's quantum is exhausted, the scheduler moves to the next tenant. The system is also 'work-conserving'; if a tenant's queue is empty, its unused quantum is distributed among the other active tenants, ensuring the API bandwidth is always fully utilized if there are pending requests.

## Tenant Fairness Guarantee

Fairness is guaranteed because the DRR algorithm ensures that every active tenant gets a chance to have their requests processed in a cyclical manner. No single tenant, regardless of how many requests it generates, can monopolize the API connection and starve others. By allocating a specific budget (quantum) to each tenant per round, the system guarantees 'eventual service' for all. This time-slicing approach prevents head-of-line blocking at the global level and ensures that even low-volume tenants receive a fair share of the API capacity.


# Nodejs Concurrency And Performance Optimization

To handle high concurrency in Node.js effectively, several best practices should be followed. The primary principle is to never block the single-threaded event loop. Any CPU-intensive or blocking I/O operations should be offloaded to worker threads or separate child processes to ensure the main thread remains responsive. Each callback or task executed on the event loop should be kept small and efficient, as the fair treatment of multiple clients is the application's responsibility. For managing asynchronous operations, a hybrid approach is recommended: serialize operations that have ordering dependencies (like a cancel-then-place sequence for the same tenant and market) using per-key queues, but allow for parallelism across unrelated keys (different tenants or markets). This prevents race conditions while maximizing throughput. Effective connection pooling is crucial for performance. This involves using a modern HTTP client like 'undici' or the native 'http.Agent' with `keepAlive` enabled. A single, shared, long-lived client instance should be created per upstream service and reused for all requests to minimize the overhead of establishing new TCP connections.

# Nodejs Http Client Configuration

## Recommended Client

undici

## Connection Pooling Enabled

True

## Keep Alive Configuration

To enable persistent connections and reduce latency from TCP and TLS handshakes, the `keepAlive` option must be set to `true` in the HTTP Agent's constructor. By default, connection pooling and persistence are limited without this setting. For finer control, you can also specify `keepAliveMsecs` to determine how long idle sockets are kept open in the pool before being destroyed.

## Global Agent Recommendation

It is a best practice to create a single, shared, long-lived HTTP client or agent instance per upstream service (e.g., one for the Polymarket API). This global instance, configured with keep-alive enabled, should be reused for all outgoing requests to that service. Instantiating a new client or agent for every request is inefficient and defeats the purpose of connection pooling.


# Implementing Order Idempotency

## Key Generation Strategy

The recommended method is to adopt a client-side key generation strategy that ensures a unique key is created for each distinct operation, but the same key is used for retries of that same operation. A robust approach involves composing the idempotency key from a combination of stable, unique identifiers related to the intended action. This could include the `tenant_id`, `market_id`, and a client-side unique `nonce` or a hash of the order intent (`order_intent_hash`). For example, a key could be structured as `tenant-X:market-Y:buy:price-Z:nonce-123`. Alternatively, a simpler and common pattern is to generate a V4 UUID on the client for each new order attempt. The key should be generated before the first attempt and stored locally so that if a retry is necessary (e.g., due to a network timeout), the exact same key can be sent again. The Polymarket API also supports a `nonce` parameter in the request body, which can be used for order uniqueness and can be part of the idempotency key's composition. These keys should have a limited lifespan, such as 24 hours, after which they can be safely purged from the system.

## Http Header Name

The idempotency key should be transmitted in the HTTP request headers. Based on the industry-standard practice detailed in the provided context from Stripe's API documentation, the conventional header name to use is `Idempotency-Key`. When making a mutating API call, such as creating an order (`POST /order`), the client should include this header with the uniquely generated key. For example: `Idempotency-Key: <your-unique-key-string>`.

## Duplicate Error Handling

The system must be designed to correctly interpret API responses related to duplicate submissions. According to the provided context, if the Polymarket API responds with an `INVALID_ORDER_DUPLICATED` error, this should not be treated as a failure. Instead, it should be interpreted as a 'success-with-existing'. This response indicates that an order with the same parameters or nonce has already been successfully processed. The application logic should handle this by treating the operation as complete and successful. It can then proceed with its workflow, potentially querying for the existing order's ID if needed, thus preventing the creation of unintended duplicate orders and avoiding unnecessary error states in the client application.


# Sqlite Concurrent Write Management

## Recommended Journaling Mode

Enable Write-Ahead Logging (WAL) mode. This mode significantly improves concurrency by allowing read transactions to run concurrently with a write transaction. While it still serializes writers to a single thread, it ensures that readers do not block writers and writers do not block readers.

## Lock Contention Strategy

To minimize lock contention, it is recommended to keep write transactions as short as possible. This can be achieved by batching multiple write operations into a single transaction and avoiding long-running read transactions that can block the checkpointing process, which is essential for managing the WAL file size. Additionally, avoiding global hot rows and using append-only logs with periodic compaction can help reduce contention points.

## Busy Handler Configuration

Set a busy timeout using `PRAGMA busy_timeout`. This configuration instructs a connection to wait for a specified amount of time if it encounters a locked database, rather than returning a `SQLITE_BUSY` error immediately. This helps the system gracefully handle brief lock contention without failing the operation.


# Recommended Sqlite Configuration Pragmas

## Journal Mode

WAL

## Synchronous

NORMAL

## Busy Timeout Ms

5000.0

## Wal Autocheckpoint

1000


# Polymarket Api Integration Details

## Post Orders Rate Limit

1,000 requests per 10 seconds and 15,000 requests per 10 minutes. These limits are enforced on a sliding time window, and exceeding them results in requests being throttled (queued/delayed) rather than immediately rejected.

## Key Order Types

The API supports several key order types. 'Post-only' orders are limit orders that are guaranteed to be a maker order; if they would match immediately upon entry (i.e., cross the spread), they are rejected instead of being executed. The context also refers to priority classes for 'marketable FOK/FAK' (Fill-Or-Kill/Fill-And-Kill) orders and passive placements, which implies support for standard limit orders (like Good-Til-Canceled or GTC) that rest on the order book.

## Duplicate Order Error Code

INVALID_ORDER_DUPLICATED


# Polymarket Session Management Heartbeat

## Timeout Interval Seconds

10.0

## Failure Consequence

If a valid heartbeat is not received within the timeout period (10 seconds, with an additional 5-second buffer), all of the user's open orders will be cancelled.

## Implementation Note

To prevent the mass cancellation of all open orders due to an idle session, it is necessary to maintain the session by sending periodic heartbeats. The context advises scheduling these heartbeats to handle the 10-second timeout and suggests implementing this with failover mechanisms. The provided text does not specify a requirement to include a `heartbeat_id` from a previous response in the next request.


# Core Design Principles For Multi Tenancy

## Tenant Isolation

Tenant isolation is achieved by architecting the system so that each tenant operates within their own logical boundary, preventing a 'noisy neighbor' from degrading the service for others. This is implemented through several mechanisms: 1) **Per-Tenant Queues:** Each tenant has an independent FIFO queue for their trading requests, which prevents head-of-line blocking where a slow or high-volume tenant could delay others. 2) **Per-Tenant Concurrency Caps:** Limits are enforced on the number of in-flight requests a single tenant can have, preventing them from monopolizing all available connections or processing slots. 3) **Independent Circuit Breakers:** If a tenant's requests consistently result in errors or timeouts from the upstream API, a circuit breaker specific to that tenant is tripped. This halts requests for the problematic tenant while allowing all other tenants to continue trading without interruption. 4) **In-Flight Guards:** To handle bursts of identical requests (e.g., copy-trading), an in-memory, singleflight-style guard is used on a per-tenant, per-operation basis. This ensures that for a given operation (like placing an order in a specific market), only one job is active at a time, and subsequent duplicate requests are coalesced to the result of the first.

## Fairness In Resource Allocation

Fairness in distributing the shared Polymarket API rate limit is critical to prevent tenant starvation. The system employs a two-tier rate-limiting strategy. First, a **Global Limiter**, typically a token bucket algorithm, is configured to match the overall API capacity provided by Polymarket (e.g., 3,500 requests per 10 seconds for `POST /order`). This ensures the system as a whole does not exceed the upstream limits. Second, a **Per-Tenant Fair Scheduler** sits on top of this global pool. It uses an algorithm like Deficit Round Robin (DRR) or Weighted Round Robin (WRR) to allocate the global request budget equitably among all active tenants. Each tenant is given a 'quantum' of requests they can make. The scheduler cycles through the tenants, serving requests from their queues. If a tenant is idle, its unused budget is automatically redistributed to other active tenants (a 'work-conserving' approach), maximizing throughput while guaranteeing that no single tenant can monopolize the API.

## Fault Tolerance And Resilience

The system is designed to be resilient to failures at both the application and network level. A key component is the use of **Stripe-style Idempotency Keys** for all mutating operations. By including a unique `Idempotency-Key` in the request header, the system can safely retry a request after a network error or timeout, confident that the operation will only be performed once. The server stores the result of the first request for a given key and returns that saved result on subsequent retries. To ensure no trade intents are lost during a process crash, a **Durable Outbox Pattern** is used, where intents are first persisted to a durable store like SQLite before being dispatched. Upon restart, the dispatcher can resume processing from the outbox, using the idempotency keys to avoid re-executing completed trades. Finally, resilience is enhanced through **Per-Tenant Fault Isolation**; if one tenant's API key is invalid or they are hitting a specific error, their individual circuit breaker will trip, isolating the failure without affecting the entire system. The system also must handle the Polymarket heartbeat, which requires a valid signal every 10 seconds to prevent a mass cancellation of all open orders, adding another layer of required resilience.


# Error Handling And Safe Retry Logic

## Idempotent Retry Strategy

For safe retries, the system should leverage the idempotency key. When a request to a mutating endpoint (like `POST /order`) fails due to a transient issue such as a network error, timeout, or a `500`-level server error, the client should retry the request. The critical rule is to use the exact same `Idempotency-Key` and request parameters for the retry. This allows the server to recognize it as a subsequent attempt of a previous request. If the original request was successfully processed but the response was lost, the server will return the saved original response without re-executing the trade. If the original request failed, the server will re-attempt it. For rate-limiting responses (HTTP `429`), the client should implement a retry mechanism with exponential backoff and jitter to avoid overwhelming the API. The idempotency key ensures that these retries do not result in duplicate orders.

## Non Retriable Error Handling

Not all errors should be retried. The system must distinguish between transient failures and final, deterministic failures. Errors that should not be retried include client-side validation errors and specific API rejections that indicate a fundamental issue with the request itself. Examples from the context include: 1) A post-only order being rejected because it would cross the spread and execute immediately. This is a design feature of post-only orders, and retrying the same order will yield the same rejection. 2) An order being rejected due to insufficient balance in the user's account for that market. Retrying will fail until the balance is increased. 3) Any `4xx` status code (other than `429` for rate limiting) generally indicates a client error (e.g., malformed request, invalid parameters) that will not be resolved by a simple retry. These errors should be logged and surfaced to the application or user as a final failure for that specific trade attempt.

## Api Error Interpretation

It is crucial to parse specific API error codes and messages to make informed decisions about system state and subsequent actions, rather than treating all errors equally. For example, an `INVALID_ORDER_DUPLICATED` error from the Polymarket API should be interpreted as a success, confirming the order already exists. A `NOT_FOUND` error when attempting to cancel an order can also be treated as a success, as the desired state (the order not being active) is achieved. Conversely, an HTTP `429` response is a clear signal to slow down and retry the request after a delay. A rejection of a post-only order is a final status for that attempt, and the system might need to decide whether to place a different order. By building logic that understands the semantics of different API responses, the trading system can operate more autonomously and maintain a more accurate internal state, ensuring robustness and reliability.

