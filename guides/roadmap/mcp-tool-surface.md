# MCP Tool Surface

This document defines the v2.0 tool-surface boundary: what the server advertises,
what it can actually do, and what is deliberately left for later. It is a surface
map, not a release plan.

## The 2.0 Surface

The server advertises exactly three MCP tools:

- `search_help_scout` finds operations by user intent and returns matching
  operation names and descriptions.
- `describe_help_scout` returns full input schemas for named operations.
- `read_help_scout` executes one named operation.

Behind those three sits an internal registry of 55 read-only Help Scout
operations covering conversations, customers, organizations, inboxes, tags,
users, teams, saved replies, attachments, workflows, webhooks, satisfaction
ratings, reports, and the Docs API. The gateway lives in `src/tools/gateway.ts`;
the operation definitions and handlers stay in `src/tools/index.ts`.

The registry is not a second advertised surface. Hosts discover operations
through `search_help_scout`, load schemas through `describe_help_scout`, then
execute through `read_help_scout`.

## Compatibility

Operation names currently in the registry still dispatch directly, so a client
that calls `getConversation` by name keeps working. Names removed in the 2.0.0
consolidation do not dispatch; they return an unknown-tool error pointing at
`search_help_scout`. The full rule lives in
[`guides/architecture/mcp-tool-contract.md`](../architecture/mcp-tool-contract.md).

## What Was Consolidated

Capabilities were folded into parent operations, not dropped.

| Removed name | Now reachable through |
| --- | --- |
| `searchInboxes` | `listAllInboxes` with `nameContains` |
| `advancedConversationSearch`, `comprehensiveConversationSearch`, `structuredConversationFilter` | `searchConversations` convenience filters |
| `getConversationV3` | `getConversation` with `includeSystemActors` |
| `getThreadsV3` | `getThreads` with `includeSystemActors` |
| `getOriginalSourceRfc822` | `getOriginalSource` with `format: "rfc822"` |
| `listCustomersV3` | `listCustomers` with `useV3` or a `cursor` |
| `getCustomerAddress`, `listCustomerEmails`, `listCustomerPhones`, `listCustomerChats`, `listCustomerSocialProfiles`, `listCustomerWebsites` | `getCustomerContacts` |
| `listSystemUsers` | `listUsers` with `includeSystemActors` |
| `getSystemUser` | `getUser` with `includeSystemActors` |
| `listUserStatuses` | `listUsers` with `includeStatuses` |
| `getUserStatus` | `getUser` with `includeStatus` |
| `listInboxCustomFields`, `listInboxFolders`, `getInboxRouting` | `getInbox` with `include: ["fields", "folders", "routing"]` |
| `getDocsSiteRestrictions` | `getDocsSite` with `includeRestrictions` |
| 32 individual report tools | 7 category operations: `getCompanyReport`, `getConversationsReport`, `getProductivityReport`, `getUserReport`, `getHappinessReport`, `getChannelReport`, `getDocsReport`, each selecting a sub-report through `report` or `channel` |

Collection operations use page-number pagination. The one exception is the v3
Customers path (`listCustomers` with `useV3` or a cursor, and
`searchCustomersByEmail`), where cursor pagination is upstream Help Scout
behavior rather than a server choice.

## Dogfood Fixture Rule

Each API-surface PR must include or reuse idempotent dogfood seed data that
exercises the core path and meaningful parameter permutations for that
operation. If a live dogfood failure is caused by missing account data, fix the
fixture setup instead of weakening coverage.

Use `npm run dogfood:seed` before authenticated dogfood runs. When a new API
family needs data the shared seed set cannot create, add the family-specific seed
step and wire it into that command. Optional credential-gated seeders, such as
Docs API fixtures, should no-op when their credentials are missing. Keep the
per-operation fixture map current in
[`guides/testing/dogfood-fixture-matrix.md`](../testing/dogfood-fixture-matrix.md).

## Future Work

### Write Operations

Write operations are post-2.0. They require a stricter permission and
confirmation model than reads. Satisfy the write-tool contract in
[`guides/architecture/mcp-tool-contract.md`](../architecture/mcp-tool-contract.md)
before implementing any mutation endpoint: classify the mutation, require
confirmation metadata for destructive or externally visible actions, verify
through MCP, and confirm cleanup.

Candidate families: draft reply creation, tagging and assignment, workflow
execution, conversation status updates.

A write surface must not be mixed into the read gateway without explicit naming,
metadata, confirmation guidance, and coverage for denied or partial actions.

### Output Schemas

Registry operations return `structuredContent` alongside serialized JSON text.
Adding `outputSchema` per operation is still open work, sequenced in the rollout
order at the end of the tool contract.

### Remote MCP And OAuth

Remote MCP, OAuth, and Cloudflare deployment are platform work. They should not
reshape the stdio gateway contract unless the stable MCP spec requires it. Open
items: remote MCP OAuth research, Workers deployment design, and a clear
separation between stdio environment credentials and HTTP authorization.

### Interactive Views

Interactive views are parked. If they are revisited, they should compose existing
operation output rather than introduce a second data path, and they should reuse
stable envelopes and dogfood fixtures without special-casing the test account.
