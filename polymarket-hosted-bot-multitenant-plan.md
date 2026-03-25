# Executive Summary

Hosting a 24/7 Polymarket API trading bot requires a compliance-focused approach to navigate IP-based blocking and adhere to API usage rules. The primary challenge stems from Polymarket's use of Cloudflare, which scrutinizes traffic from common cloud and datacenter IPs (like AWS, GCP) due to their association with automated abuse, assigning higher risk scores based on IP reputation and Autonomous System Number (ASN). Additionally, Polymarket enforces strict geographic restrictions for regulatory compliance. The key to successful and stable operation is not evasion, but adherence to official guidelines. Solutions involve using the official CLOB and Data APIs within their documented rate limits, and proactively checking for geographic eligibility using Polymarket's `geoblock` endpoint. For hosting, the recommended strategy is to use standard cloud providers (AWS, GCP) or cost-effective alternatives (Hetzner, DigitalOcean) but ensure a stable, reputable egress IP address, for instance by using a NAT gateway. This avoids the high-risk profile of generic, shared cloud IPs. For a multi-tenant SaaS application, the architecture must prioritize security and isolation, using a pooled or per-tenant model with strong logical separation, secure user authentication (OIDC), and non-custodial or HSM-backed custodial wallet management. All sensitive credentials, such as API keys and private keys, must be stored and managed in a dedicated secrets manager like HashiCorp Vault or a cloud provider's KMS. Ultimately, long-term success depends on maintaining good IP hygiene, respecting API limits with client-side throttling, handling errors gracefully, and building a resilient, secure system that follows Polymarket's Terms of Service.

# Ip Blocking Rationale

Polymarket and its security provider, Cloudflare, block or challenge requests from common cloud and datacenter IPs (such as those from AWS, GCP, and Railway) as a primary defense against automated abuse like scraping and malicious bot activity. This practice is rooted in several security concepts:

1.  **IP Reputation and ASN Blocking**: Cloudflare's Web Application Firewall (WAF) and bot management systems heavily rely on IP reputation. Datacenter IP ranges and their associated Autonomous System Numbers (ASNs) are frequently used for malicious activities, causing them to have a lower reputation score. Consequently, traffic originating from these well-known cloud provider ASNs is often treated as inherently riskier and may be subject to stricter scrutiny, challenges (like CAPTCHAs), or outright blocks. Website administrators can use Cloudflare's IP Access Rules to explicitly block, challenge, or allow traffic based on IP address, country, or ASN.

2.  **Bot Management Scores**: Cloudflare assigns a 'bot score' to every request, which is determined by a machine learning model. This score factors in the network origin (ASN), behavioral patterns, and technical fingerprints of the client. Requests from datacenter IPs are more likely to be flagged as automated and receive a score indicating they are likely a bot, which can trigger defensive actions.

3.  **Geographic Restrictions**: Independent of Cloudflare's bot detection, Polymarket enforces its own geoblocking at the application layer to comply with regulatory requirements and international sanctions. It explicitly restricts order placement from certain countries and regions, including the United States. Polymarket provides a public API endpoint (`/api/geoblock`) for users to verify if their IP address is in a restricted location. Therefore, even if a request bypasses Cloudflare's initial checks, it may still be blocked by Polymarket's own compliance rules if it originates from a forbidden territory. The distinction between allowed (local/residential) and blocked (datacenter) IPs is thus a function of risk profiling and regulatory compliance, where datacenter IPs are statistically more likely to be associated with abuse and residential IPs are treated as more likely to be legitimate human users, though even residential proxies are now being targeted by advanced bot detection.

# Cloudflare Bot Detection Mechanisms

Cloudflare employs a sophisticated suite of bot management techniques to differentiate legitimate users from automated bots, particularly those originating from datacenter networks. These mechanisms are designed to detect and mitigate abusive automation while minimizing impact on genuine traffic.

1.  **Machine Learning-Based Bot Scoring**: The core of Cloudflare's system is a machine learning model that analyzes every request and assigns it a 'bot score' ranging from 1 (definitely a bot) to 99 (definitely human). This model is trained on a massive dataset and considers a wide array of signals, including the request's network origin (ASN), behavioral heuristics, and various technical fingerprints. Traffic from datacenter ASNs is a significant feature in this model, often leading to a lower (more bot-like) score.

2.  **Behavioral Analysis**: The system analyzes user behavior over time. It looks for patterns indicative of automation, such as request rates, navigation paths, and mouse movements or touch events (for browser-based clients). A trading bot making rapid, repetitive API calls without typical user interaction patterns would be flagged by this analysis.

3.  **TLS and HTTP Fingerprinting**: Cloudflare inspects the technical characteristics of the connection itself. This includes TLS fingerprinting (also known as JA3 fingerprinting), which analyzes the specific combination of ciphers, extensions, and parameters used to initiate a secure connection. Different HTTP clients, libraries (like Python's `requests`), and browsers have unique fingerprints. Bots often use common libraries with recognizable fingerprints, which allows Cloudflare to identify them. Mismatches between the user-agent string and the TLS fingerprint are a strong signal of a bot.

4.  **Targeted Detection Models**: Cloudflare continuously develops and deploys new ML models to address evolving threats. For example, it has released models specifically designed to detect bots that use residential proxies to mask their origin. This demonstrates that simply using a non-datacenter IP is not a foolproof method for evasion, as the detection models also analyze the intrinsic behavior and technical makeup of the request itself.

Based on the bot score, site administrators can create granular WAF (Web Application Firewall) rules to block, challenge, or rate-limit requests, allowing them to precisely control how suspected bot traffic is handled.

# Workable Hosting And Proxy Solutions

## Solution Type

Managed Enterprise Proxy

## Description

This solution involves using enterprise-grade proxy providers that verify a user's business identity and allocate dedicated, static IP addresses. The focus is on compliance and maintaining a high IP reputation, rather than evasion. By using a dedicated IP with abuse monitoring, you avoid sharing an IP with potentially malicious actors and present a stable, reputable identity to Polymarket's infrastructure. The source material suggests this approach for compliance use-cases, advising to avoid 'evasion' providers.

## Effectiveness

High

## Cost Level

High

## Solution Type

Cloud Hosting with Fixed Egress IP

## Description

This method uses a standard cloud provider (like AWS or GCP) but configures the network to route all outbound traffic through a static, fixed IP address using a service like a NAT Gateway. This provides a consistent egress identity, allowing you to build a positive IP reputation over time. It is presented as a less error-prone production pattern and opens the possibility of requesting IP allowlisting from Polymarket for mission-critical applications.

## Effectiveness

High

## Cost Level

Medium

## Solution Type

Residential Proxy

## Description

These services route traffic through IP addresses belonging to real residential internet users, which can bypass blocks that specifically target datacenter IP ranges. However, the provided context explicitly notes that Cloudflare's machine learning models are now specifically designed to detect and block abusive bot traffic originating from residential proxies, making this a less reliable long-term solution.

## Effectiveness

Medium

## Cost Level

Medium


# Vps Hosting In Approved Regions

To bypass geoblocking, it is essential to host your application on a Virtual Private Server (VPS) located in a geographic region that is not restricted by Polymarket. According to Polymarket's documentation, the platform's primary servers are located in `eu-west-2`. The documentation explicitly identifies `eu-west-1` as the 'Closest Non-Georestricted Region.' Therefore, the recommended strategy is to select a VPS provider that allows you to deploy a server in `eu-west-1` or another approved European region. This ensures compliance with Polymarket's terms of service regarding geographic restrictions. Hosting in a nearby region like `eu-west-1` also provides the added benefit of lower network latency to Polymarket's core CLOB API servers, which is critical for trading applications. While major cloud providers like AWS and GCP offer this, more affordable alternatives such as Hetzner, OVH, Vultr, or DigitalOcean can also be used, provided they offer hosting in a compliant location.

# Serverless Architecture With Exit Nodes

A serverless architecture can be effectively used for a trading bot by combining serverless compute functions (like AWS Lambda or GCP Cloud Run) with a networking setup that provides a stable exit IP. This pattern, described as 'Serverless with fixed egress,' involves running the functions within a Virtual Private Cloud (VPC). All outbound traffic from these functions is then routed through a NAT (Network Address Translation) Gateway, which has a static, fixed IP address. This approach provides several benefits: it avoids the ephemeral and often-flagged IP ranges typically associated with serverless platforms, it establishes a consistent and reputable IP identity for your bot, and it allows you to comply with geoblocking by ensuring the NAT Gateway is provisioned in an approved region (e.g., `eu-west-1`). This architecture combines the operational efficiency and pay-per-use cost model of serverless with the stability and reputation benefits of a fixed IP, making it a scalable and difficult-to-block solution that prioritizes compliance over evasion.

# Multi Tenant Saas Architecture Blueprint

A high-level design for a multi-tenant copy-trading bot SaaS application involves several core components designed for security, isolation, and scalability. The tenancy model should be a pooled model with strong logical isolation, where a `tenant_id` is propagated and enforced at every layer of the application. For high-risk operations like trade execution and cryptographic signing, a service-per-tenant model should be considered to minimize the blast radius of any potential security incident. The architecture includes a shared discovery engine responsible for fetching market data, order books, and events from Polymarket's Gamma, Data, and CLOB APIs. This engine should aggressively cache data and multiplex read requests to stay within documented rate limits. It then applies trading strategies and emits signals to tenant-specific executors, which handle the actual trading logic for each user. The data plane must partition all data by tenant, using either separate schemas or row-level security in the database. All sensitive data must be encrypted at rest and in transit. A critical component is an immutable audit log that records all trade intents, signed payloads, and responses from the exchange for compliance and debugging. For hosting, a cloud IaaS provider like AWS, GCP, or Azure is recommended for its mature security features, DDoS protection, and high availability through multi-AZ deployments. For cost-conscious operations, providers like Hetzner or OVH can be used, provided they are paired with managed databases and secrets managers. A serverless approach using AWS Lambda or Google Cloud Run with VPC egress for stable IPs is also a viable, cost-effective option for bursty workloads.

# User And Session Management Design

User and session management for the multi-tenant application should be implemented using a robust, standards-based approach. User authentication should be handled via an external identity provider that supports OpenID Connect (OIDC), such as Auth0 or AWS Cognito. This allows for secure user logins, password management, and multi-factor authentication. Upon successful login, the application will receive a short-lived access token and a refresh token. Within the application, a per-user or per-tenant profile system must be maintained, defining roles and permissions such as 'viewer', 'trader', or 'admin'. These roles will control access to different features of the SaaS platform. Session management will rely on the secure handling of access tokens, which should be used to authorize all API requests from the client to the application backend. For interacting with Polymarket's trading endpoints, the backend will use the user's configured wallet and API credentials. This involves Polymarket's specific two-level authentication: L1, which uses the wallet's private key to sign an EIP-712 message, and L2, which uses HMAC-SHA256 to sign requests with derived API credentials (apiKey, secret, passphrase). The user's session token authorizes the backend to perform these actions on their behalf, but the session token itself is never exposed to Polymarket.

# Secure Api Key And Wallet Management

## Recommended Tool

HashiCorp Vault or AWS KMS with Secrets Manager

## Strategy

Envelope Encryption

## Access Control Method

IAM Policies or Vault ACLs

## Data To Protect

User private keys for L1 authentication signing, derived Polymarket API credentials (apiKey, secret, passphrase) for L2 authentication, and any other sensitive configuration data.


# Tenant Isolation Strategies

Strict data and operational isolation between tenants is achieved through a multi-layered approach. The foundational layer is logical isolation, where every piece of data and every process is tagged with a `tenant_id`. This identifier must be propagated through all service calls and used in every database query to filter data. For data storage, tenants' data should be partitioned, either by using a separate database schema per tenant or by implementing strict row-level security (RLS) policies in a shared schema. For operational isolation, while a shared discovery engine can be used for reading public market data, the execution of trades must be handled by tenant-specific executors. This ensures that one tenant's trading volume or logic does not impact another's. A stronger form of isolation involves creating service-per-tenant boundaries for high-risk operations like trade signing, which significantly reduces the blast radius of a potential breach. For wallet isolation, the system must distinguish between read-only 'tracked wallets' (where only the address is stored) and 'trading wallets'. For trading wallets, a non-custodial approach where the user signs transactions is preferred, but for a custodial model, each tenant's private keys and API keys must be cryptographically isolated and stored in a secrets manager like AWS KMS or HashiCorp Vault, with access controlled by strict, tenant-specific IAM or ACL policies.

# Affordable Enterprise Grade Hosting Options

## Provider

AWS / GCP / Azure

## Service Type

Cloud IaaS (VPS/Compute)

## Recommended Region

eu-west-1

## Estimated Cost

Variable based on usage; offers mature security, DDoS protection, and managed services but can be higher cost than alternatives. Suitable for complex deployments requiring a rich ecosystem.

## Provider

Hetzner / OVH

## Service Type

VPS / Dedicated Server

## Recommended Region

eu-west-1

## Estimated Cost

Lower cost than major cloud providers. Offers reliable compute, but may require more manual configuration for high availability and managed services.

## Provider

Vultr / DigitalOcean

## Service Type

VPS (Compute)

## Recommended Region

eu-west-1

## Estimated Cost

Competitive pricing, generally lower than major IaaS providers. Good balance of cost and features for standard bot hosting.

## Provider

AWS Lambda / GCP Cloud Run / Azure Functions

## Service Type

Serverless

## Recommended Region

eu-west-1

## Estimated Cost

Pay-per-use model. Can be highly cost-effective for bursty or event-driven bots, cutting operational overhead. Costs for associated services like NAT gateways for fixed egress should be considered.


# Cost Analysis Of Hosting Solutions

The cost of hosting a Polymarket trading bot involves a trade-off between price, features, and operational effort. 

1.  **Major Cloud Providers (AWS/GCP/Azure):** These platforms provide a mature, secure, and highly available environment but can be more expensive. The cost includes not just the compute instances but also associated services like managed databases, secrets managers (KMS), and networking components like NAT Gateways for providing a stable egress IP. The trade-off is a higher cost for a robust, scalable, and feature-rich ecosystem that reduces operational burden and enhances security.

2.  **Cost-Savvy Alternatives (Hetzner, OVH, Vultr, DigitalOcean):** These providers offer reliable compute (VPS and dedicated servers) at a significantly lower price point. The trade-off is that achieving the same level of resilience and security as major clouds may require more manual setup. You might need to pair their services with external managed databases, secrets managers, and uptime monitors, which can add to the complexity and hidden operational cost, though the base compute cost remains low.

3.  **Serverless Platforms (AWS Lambda, GCP Cloud Run):** This model can be extremely cost-effective, especially for bots with intermittent or bursty trading activity, as you only pay for the execution time and number of requests. It eliminates server management overhead. However, costs for necessary peripheral services, such as a VPC connector and NAT Gateway to ensure a stable, reputable egress IP, must be factored into the total cost. The trade-off is a potentially lower overall cost and reduced ops for a different architectural paradigm.

4.  **Managed Proxies:** The report advises against cheap 'evasion' proxies and recommends enterprise providers for compliance use cases. This implies that reliable, compliant proxies with dedicated IPs and clear terms of service come at a premium cost. The trade-off is paying more for a lower-risk, compliant network egress path versus using cheaper, riskier options that could be flagged by bot detection systems and violate terms of service.

# Polymarket Api Rate Limit Guidelines

## Api Endpoint

CLOB POST /order

## Rate Limit

500 every 10s

## Equivalent Rate Per Second

50/s

## Limit Type

BURST


# Navigating Geographic Restrictions

## Location Name

United States

## Location Code

US

## Status

Blocked

## Scope

Country


# Api Authentication Best Practices

## Level

L2 (API Key)

## Method

HMAC-SHA256 Signature

## Primary Use Case

Placing signed orders

## Required Headers

POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE


# Bot Behavioral Best Practices

To avoid bans, rate limits, and trade rejections, a trading bot must strictly follow Polymarket's official documentation and Terms of Service. This involves using the specified L1 and L2 authentication methods correctly, ensuring server clocks are synchronized via NTP for accurate timestamps in headers, and never attempting to circumvent geographic restrictions. Bots should implement client-side throttling with jittered backoff to stay within documented rate limits, such as the burst and sustained limits for placing and deleting orders. It is also advisable to use bulk endpoints like `/prices` and `/books` where possible and to cache responses to reduce request frequency. Before executing a trade, the bot should pre-flight the user's geoblock status and account mode (e.g., cancel-only) and validate order parameters locally to minimize rejections. Gracefully handling API errors like 401 (Unauthorized), 429 (Too Many Requests), and 503 (Service Unavailable) is essential for robust operation. Finally, maintaining a stable egress identity with a good reputation and practicing strong security hygiene, such as rotating keys and using a secrets manager, can help avoid being flagged for suspicious activity.
