# Common Help Scout MCP Mistakes

Detailed anti-patterns with explanations and fixes.

---

## Mistake 1: Calling Operation Names as MCP Tools

**What happens:**
```javascript
// WRONG:
mcp__helpscout__searchConversations({ contentTerms: ["billing"] })
// Error: no such tool
```

**Why it fails:** The server advertises exactly three tools: `search_help_scout`, `describe_help_scout`, and `read_help_scout`. The 55 operations live behind them.

**Correct approach:**
```javascript
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["billing"] }
})
```

---

## Mistake 2: Guessing Arguments Instead of Describing First

**What happens:**
```javascript
// WRONG:
read_help_scout({ name: "searchConversations", arguments: { searchTerms: ["refund"] } })
// searchTerms is not a valid argument
```

**Why it fails:** Each operation has its own schema. Guessed argument names silently filter nothing or error.

**Correct approach:**
```javascript
// Step 1: Get the real schema
describe_help_scout({ names: ["searchConversations"] })

// Step 2: Use the documented arguments
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["refund"] }
})
```

---

## Mistake 3: Looking Up Inboxes You Already Have

**What happens:**
```javascript
// User says: "Search the support inbox for billing"
// Wasteful:
read_help_scout({ name: "listAllInboxes", arguments: {} })
// The inbox IDs were already in the server instructions
```

**Why it's wrong:** Inboxes are auto-discovered at connect time and listed with their IDs in the server instructions.

**Correct approach:**
```javascript
// Read the inbox ID straight from the server instructions, then:
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["billing"], inboxId: "359402" }
})
// Only call listAllInboxes (optionally with nameContains) if inboxes changed mid-session
```

---

## Mistake 4: Using Inbox Names Instead of IDs

**What happens:**
```javascript
// WRONG:
read_help_scout({ name: "searchConversations", arguments: { inboxId: "Support" } })
read_help_scout({ name: "searchConversations", arguments: { inboxId: "sales@company.com" } })
// Both fail - not valid inbox IDs
```

**Why it fails:** Inbox IDs are numeric (like `359402`), not names or emails.

**Correct approach:** Use the numeric ID listed in the server instructions.

---

## Mistake 5: Narrowing Status Out of Habit

**What happens:**
```javascript
// User says: "Find tickets about refunds"
// Suboptimal:
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["refund"], status: "active" }
})
// Misses closed and pending tickets, which is most of them
```

**Why it's wrong:** `searchConversations` already searches active + pending + closed by default (spam excluded). Adding `status` narrows the result.

**Correct approach:**
```javascript
// Omit status unless the user asked for a specific one
read_help_scout({ name: "searchConversations", arguments: { contentTerms: ["refund"] } })

// Explicit narrowing when asked:
read_help_scout({ name: "searchConversations", arguments: { contentTerms: ["refund"], status: "closed" } })
```

---

## Mistake 6: Using Removed Operation Names

**What happens:**
```javascript
// WRONG:
read_help_scout({ name: "comprehensiveConversationSearch", arguments: { ... } })
// Error: unknown operation
```

**Why it fails:** Older guidance taught operations that no longer exist.

**Migration map (old → new):**
- `searchInboxes` → `listAllInboxes` (optionally `nameContains`), or just read the server instructions
- `advancedConversationSearch` / `structuredConversationFilter` (and the comprehensive search above) → `searchConversations` with convenience filters (`contentTerms`, `subjectTerms`, `email`, `emailDomain`, `customerIds`, `hasAttachments`, `inboxId`, `folderId`, `tag`, `status`, `createdAfter`/`createdBefore`, `conversationNumber`, `assignedTo`)
- `listCustomersV3` → `listCustomers` with `useV3` or a `cursor`
- `getCustomerAddress` and other contact sub-resources → `getCustomerContacts`

---

## Mistake 7: Filtering by Assignee Name

**What happens:**
```javascript
// User says: "Find tickets assigned to John"
// WRONG:
read_help_scout({ name: "searchConversations", arguments: { assignedTo: "John" } })
// assignedTo requires a user ID (number), not a name
```

**Correct approach:**
```javascript
// Step 1: Find John's user ID
read_help_scout({ name: "listUsers", arguments: {} })

// Step 2: Filter by ID (-1 means unassigned)
read_help_scout({ name: "searchConversations", arguments: { assignedTo: 12345 } })
```

---

## Mistake 8: Not Including Search Term Variations

**What happens:**
```javascript
// User says: "Find billing issues"
// Suboptimal:
read_help_scout({ name: "searchConversations", arguments: { contentTerms: ["billing"] } })
// Misses "invoice", "payment", etc.
```

**Better approach:**
```javascript
// contentTerms are OR-combined
read_help_scout({
  name: "searchConversations",
  arguments: { contentTerms: ["billing", "invoice", "payment"] }
})
```

---

## Mistake 9: Ignoring Pagination for Large Result Sets

**What happens:**
```javascript
// User says: "Get all tickets from last month"
// WRONG:
read_help_scout({ name: "searchConversations", arguments: { createdAfter: "2026-06-01T00:00:00Z" } })
// Only returns the first page (default limit 50)
```

**Correct approach:**
```javascript
// Walk pages until results run out
read_help_scout({
  name: "searchConversations",
  arguments: { createdAfter: "2026-06-01T00:00:00Z", limit: 100, page: 1 }
})
// then page: 2, page: 3, ...
```

---

## Mistake 10: Hardcoding "Today" in Date Filters

**What happens:**
```javascript
// User says: "Tickets from the last 7 days"
// Fragile: guessing the current date for createdAfter
```

**Correct approach:**
```javascript
// Step 1: Get the authoritative clock
read_help_scout({ name: "getServerTime", arguments: {} })

// Step 2: Compute the ISO date from that response
read_help_scout({
  name: "searchConversations",
  arguments: { createdAfter: "<serverTime minus 7 days>" }
})
```

---

## Mistake 11: Missing Content in Thread Retrieval

**What happens:**
```javascript
read_help_scout({ name: "getConversationSummary", arguments: { conversationId: "12345678" } })
// Returns: { body: "[Content hidden - set REDACT_MESSAGE_CONTENT=false to view]" }
```

**Why it fails:** The MCP server was configured with message content redaction enabled.

**Note:** This plugin defaults to `REDACT_MESSAGE_CONTENT=false` (content visible). If you see redacted content, you may be using a different MCP configuration.

To replace message bodies with placeholders, set:
```bash
export REDACT_MESSAGE_CONTENT=true
```

---

## Mistake 12: Expecting Write Operations

**What happens:** Asking any operation to reply, tag, assign, or close a ticket.

**Why it fails:** Every operation in the registry is read-only. There is no create, update, or delete surface.

**Correct approach:** Do the write in the Help Scout UI, then verify with a read operation.

---

## Quick Checklist

Before any HelpScout operation, verify:

| Check | Action |
|-------|--------|
| Unsure which operation to use? | `search_help_scout` with the user's intent |
| About to build arguments? | `describe_help_scout` for the exact schema |
| Executing? | `read_help_scout({ name, arguments })`, never the operation name as a tool |
| User mentioned an inbox? | Use the numeric ID from server instructions |
| Conversation search? | `searchConversations`; omit `status` (default is active+pending+closed) |
| Filtering by assignee? | Need a numeric user ID (`listUsers` first; -1 = unassigned) |
| Large result set expected? | Handle pagination with `limit` and `page` |
| Date-relative query? | `getServerTime` first, then ISO dates |
