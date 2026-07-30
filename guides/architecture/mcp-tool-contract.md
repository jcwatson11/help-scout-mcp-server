# MCP Tool Contract

This server targets the latest stable Model Context Protocol specification:
`2025-11-25`.

The official MCP documentation labels `2025-11-25` as the latest stable
specification. Draft documentation may describe proposed newer protocol shapes,
including the `2026-07-28` draft stream, but those draft behaviors are not a
required compatibility target until they are published as stable.

Source references:

- https://modelcontextprotocol.io/specification/2025-11-25
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## Compatibility Baseline

- The stdio server remains the primary transport.
- Help Scout credentials are read from environment variables for stdio clients.
- HTTP transport and OAuth authorization are separate future work.
- Existing clients that parse `content[].text` must keep working.
- Tool results that expose structured JSON should return both:
  - `structuredContent` with the JSON object
  - a serialized JSON `TextContent` block for backward compatibility
- `outputSchema` should be added only when the result shape is stable enough to
  validate without breaking normal Help Scout API variation.
- Tool input and output schemas default to JSON Schema 2020-12 unless an
  explicit `$schema` is required.

## Advertised Tools And Registry Operations

The server presents two layers, and the rules below distinguish them.

- **Advertised gateway tools** are the three tools returned by `tools/list`:
  `search_help_scout`, `describe_help_scout`, and `read_help_scout`. They are
  defined in `src/tools/gateway.ts`.
- **Registry operations** are the 55 read-only Help Scout operations defined in
  `src/tools/index.ts`. They are discovered through `search_help_scout`,
  schema-loaded through `describe_help_scout`, and executed through
  `read_help_scout`.

"Tool" in the sections below means an advertised gateway tool. "Operation" means
a registry entry. Both share the result, error, and envelope rules.

## Tool Metadata

Each advertised gateway tool and each registry operation should have:

- A stable machine name. Advertised gateway tools use snake_case
  (`search_help_scout`, `describe_help_scout`, `read_help_scout`). Registry
  operations use the existing camelCase style (`getConversation`, `listUsers`).
- A human-readable `title` for MCP hosts that render display names.
- A direct, user-intent description, not an internal endpoint description. For
  registry operations the description is also the ranking text for
  `search_help_scout`, so it should carry the words a user would actually type.
- A valid `inputSchema`. Entries with no arguments should explicitly accept an
  empty object.
- `annotations.readOnlyHint: true`, which currently applies to every advertised
  tool and every registry operation.
- `outputSchema` once the returned structure is intentionally stable.

Icons are optional display metadata. Add them only when supported by the server
SDK and packaged clients can consume them consistently.

## Result Shape

All read operations should converge on a predictable result envelope:

```json
{
  "data": {},
  "meta": {
    "source": "helpscout",
    "fetchedAt": "2026-06-13T00:00:00.000Z"
  }
}
```

List and search operations should use a collection envelope:

```json
{
  "items": [],
  "page": {
    "page": 1,
    "size": 50,
    "hasMore": false
  },
  "filters": {},
  "meta": {
    "source": "helpscout",
    "fetchedAt": "2026-06-13T00:00:00.000Z"
  }
}
```

Pagination is page-number based. The v3 Customers path is the exception:
`listCustomers` with `useV3` or a `cursor`, and `searchCustomersByEmail`, return
a `nextCursor` because cursor pagination is upstream Help Scout behavior on those
endpoints, not a server choice.

The envelope should not hide useful Help Scout fields. Preserve raw identifiers,
links, timestamps, and relevant embedded objects unless redaction is enabled.
`REDACT_MESSAGE_CONTENT=true` hides message bodies to save host context. It is a
context-saver, not a PII or compliance guarantee.

## Error Policy

Use MCP tool results for errors the model can act on:

- Validation errors
- Missing required arguments
- Unknown Help Scout IDs
- Help Scout API errors that return a useful status or message
- Partial failures where some requested subresources failed

Use protocol-level errors for server or transport failures:

- Invalid MCP messages
- Startup failure
- Broken transport
- Unexpected process errors before the tool handler can respond

Tool errors should be structured and readable, with `isError` set when the MCP
SDK supports it. Error payloads should include the failing Help Scout status,
operation, and model-correctable guidance when available.

## Naming

### Advertised Gateway Tools

The three advertised tools use snake_case verb-first names that read as
capabilities rather than Help Scout resources: `search_help_scout`,
`describe_help_scout`, `read_help_scout`. This set is intentionally closed. Do
not add a fourth advertised tool to expose a Help Scout resource; add a registry
operation instead. A new advertised tool is justified only by a new interaction
mode, and a write path would be the first candidate.

An operation name may never collide with a gateway tool name. The registry build
rejects the collision at startup, because a colliding operation would be
unreachable.

### Registry Operations

Registry operations keep the camelCase style and names that match support
workflows:

- `listX` for browseable metadata and collections.
- `getX` for direct ID or slug lookups.
- `searchX` for user-entered query or filter workflows.
- `summarizeX` only when the server creates a derived support summary.
- Write-capable operations must use explicit verbs that name the mutation:
  `createX`, `updateX`, `deleteX`, `setX`, `removeX`, `uploadX`, `runX`, or
  another Help Scout-aligned verb when those are more precise.

Avoid exposing raw Help Scout endpoint names when a workflow name is clearer.
Prefer a parameter on an existing operation over a near-duplicate operation:
API-version variants belong behind a flag, sub-resources behind an `include`
list, and report families behind a `report` or `channel` selector.

Avoid adding write verbs until the write-tool contract below is satisfied.

## Name Compatibility Rule

This is the canonical statement of what names a client may call.

1. The three advertised gateway tool names always dispatch.
2. Any operation name currently in the registry also dispatches directly, as a
   compatibility path for clients that learned the pre-2.0 names. Direct calls
   bypass discovery and behave identically to the same operation invoked through
   `read_help_scout`.
3. Names removed in the 2.0.0 consolidation do not dispatch. They return a tool
   error naming the unknown tool and pointing at `search_help_scout`.

Rule 2 is compatibility, not a supported second surface. New clients should
discover through `search_help_scout` and execute through `read_help_scout`;
direct-dispatch support may be withdrawn in a later major release.

Removing or renaming a registry operation is a breaking change. Fold its
capability into a parent operation, record the mapping in
[`guides/roadmap/mcp-tool-surface.md`](../roadmap/mcp-tool-surface.md), and
release the change under a major version.

## Write Tool Contract

Write tools are direct Help Scout API parity tools. They are not operator
workflow products, MCP Apps views, or hidden multi-step automations. Each write
tool should map to one Help Scout mutation endpoint or one tightly scoped API
operation family.

### Mutation Classes

Classify each write tool in its implementation notes, tests, and dogfood plan:

- `nonDestructive`: creates disposable data or updates a reversible test
  record without external customer visibility.
- `reversible`: changes Help Scout state but can be restored by a documented
  API call in the same dogfood lifecycle.
- `externallyVisible`: can notify customers, publish Docs content, expose a
  redirect, trigger a webhook, run a workflow, or otherwise affect people
  outside the test process.
- `destructive`: deletes records, removes contact paths, disables workflows,
  removes redirects, deletes Docs content, or makes recovery impossible through
  the same tool family.

Externally visible and destructive tools require explicit confirmation metadata.

### Confirmation Metadata

For destructive or externally visible operations, the input schema must include
confirmation fields that are hard to satisfy accidentally:

```json
{
  "confirm": true,
  "confirmOperation": "deleteCustomer",
  "targetId": "12345"
}
```

The exact confirmation string should name the operation and target. The tool
must reject calls with missing, false, or mismatched confirmation before making a
Help Scout request. Confirmation requirements belong in the tool description and
validation tests.

### Dry Run And Preview

Use dry-run behavior only when it can be honest:

- If the Help Scout API supports previewing or validating without mutation, call
  the supported API path.
- If no preview API exists, a `dryRun` mode may validate inputs and report the
  request that would be sent, but it must clearly say that Help Scout state was
  not checked.
- Do not fake success by simulating Help Scout side effects locally.

### Result Envelopes

Write results should use a predictable envelope:

```json
{
  "operation": "updateConversation",
  "mutationClass": "reversible",
  "target": { "type": "conversation", "id": "12345" },
  "status": "succeeded",
  "result": {},
  "cleanup": {
    "required": false,
    "performed": false,
    "instructions": null
  }
}
```

Validation failures should return model-correctable tool errors without sending
an upstream request. Partial failures should name which sub-operation succeeded,
which failed, and what cleanup remains. Never hide a cleanup failure.

### Live Dogfood Lifecycle

Every write-tool PR must prove live behavior against disposable fixtures:

1. Create or discover a test-owned target with an `MCP-TEST:` marker or another
   deterministic test marker.
2. Perform the mutation through MCP over stdio, not by calling helper code
   directly.
3. Read the target back through an existing read tool or direct API contract
   check to verify the Help Scout state.
4. Restore or delete the fixture when the operation is reversible or disposable.
5. Fail loudly if cleanup cannot be confirmed.

Fixture setup belongs in idempotent seed scripts when it is reusable. PRs must
update the dogfood fixture matrix with the records they create, reuse, skip, or
cannot safely clean up.

### Deny And Permission Behavior

Permission errors, plan-limit errors, invalid IDs, and Help Scout validation
errors are expected API outcomes. Return them as tool errors with the upstream
status/code and model-correctable guidance. Do not retry non-idempotent writes
unless the endpoint and request body are explicitly safe to repeat.

## Boundaries

Tools and operations are model-controlled and should stay focused on Help Scout
data access. Use the other MCP feature surfaces deliberately:

- Resources: stable, fetchable context objects such as documentation pages or
  cached large attachments.
- Prompts: repeatable support workflows that combine multiple operations.
- Sampling and elicitation: out of scope until there is a concrete workflow that
  requires host-mediated model calls or user input.
- Interactive views: parked. If revisited, they must compose existing operation
  output rather than open a second data path.

## Output Schema Rollout

`title`, read-only annotations, explicit empty input schemas, and
`structuredContent` alongside serialized JSON text are in place across the
registry. Remaining work is `outputSchema` per operation, sequenced by envelope
stability:

1. Utility and metadata operations first, where the shape barely varies:
   `getServerTime`, `getInbox`, `listCustomerProperties`,
   `listOrganizationProperties`, `getOrganizationProperty`, `listTags`, `getTag`,
   `listUsers`, `getUser`, `listTeams`, `getTeamMembers`.
2. Customer and organization lookups: `getCustomer`, `getCustomerContacts`,
   `getOrganization`, `listOrganizations`.
3. Conversation search and thread operations after the collection envelope is
   stable: `searchConversations`, `getConversation`, `getThreads`,
   `getConversationSummary`.
4. Report category operations, whose payloads vary by the selected `report` or
   `channel` and need per-sub-report shapes before validation is honest.
5. Docs operations, after the shared envelope work lands.

Then extend the dogfood harness to validate gateway tool metadata, operation
metadata, structured content, and schema conformance.
