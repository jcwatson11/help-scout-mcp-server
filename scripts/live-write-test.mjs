// Live end-to-end test of the 2.x write path against the REAL Help Scout API.
// Drives the built write gateway exactly as an MCP client would.
//
// Credentials: put HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET (and
// HELPSCOUT_ENABLE_WRITES=true) in ~/Source/hs-reconcile/.env (gitignored).
// dotenv is loaded by the built config module.
//
// Usage (run with CWD = repo root so .env is found):
//   node scripts/live-write-test.mjs                 # discovery only: lists mailboxes
//   MAILBOX_ID=123 CUSTOMER_EMAIL=you@example.com node scripts/live-write-test.mjs
//
// Safety: creates a customer-authored conversation (inbound — no outbound email),
// adds an internal note, saves a DRAFT reply (no email sent — exercises the
// primaryCustomer fallback), then closes the ticket. No delete op exists; close
// is the terminal state. Nothing here emails a real customer.

import { writeGatewayHandler } from '../dist/tools/write-gateway.js';

const MAILBOX_ID = process.env.MAILBOX_ID ? Number(process.env.MAILBOX_ID) : undefined;
const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL;

async function call(opName, args = {}) {
  const res = await writeGatewayHandler.callTool({
    method: 'tools/call',
    params: { name: 'write_help_scout', arguments: { name: opName, arguments: args } },
  });
  const text = res.content?.[0]?.text ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: Boolean(res.isError), parsed };
}

function show(label, result) {
  console.log(`\n=== ${label} ${result.isError ? '❌ ERROR' : '✅'} ===`);
  console.log(typeof result.parsed === 'string' ? result.parsed : JSON.stringify(result.parsed, null, 2));
  if (result.isError) throw new Error(`${label} failed`);
}

async function main() {
  // 0. Prove the gateway self-describes.
  const catalog = await writeGatewayHandler.callTool({
    method: 'tools/call', params: { name: 'write_help_scout', arguments: {} },
  });
  const ops = JSON.parse(catalog.content[0].text).operations.map((o) => o.name);
  console.log('write_help_scout catalog:', ops.join(', '));

  // 1. Discover mailboxes (write-gated read).
  const mailboxes = await call('listMailboxes', {});
  show('listMailboxes', mailboxes);

  if (!MAILBOX_ID || !CUSTOMER_EMAIL) {
    console.log('\n>> Discovery only. Re-run with MAILBOX_ID=<id> CUSTOMER_EMAIL=<addr> to exercise writes.');
    return;
  }

  const stamp = process.env.STAMP || 'live-test';
  let conversationId;
  if (process.env.CONVERSATION_ID) {
    // Continue against an already-created ticket (avoids making more tickets).
    conversationId = Number(process.env.CONVERSATION_ID);
    console.log('Continuing with existing conversationId =', conversationId);
  } else {
    // 2. Create a dummy ticket (customer-authored thread → inbound, no email).
    const created = await call('createConversation', {
      subject: `[${stamp}] 2.x write gateway smoke test`,
      customer: { email: CUSTOMER_EMAIL, firstName: 'Write', lastName: 'Test' },
      mailboxId: MAILBOX_ID,
      type: 'email',
      status: 'active',
      text: `Automated 2.x write-gateway test (${stamp}). Safe to delete.`,
    });
    show('createConversation', created);
    // createConversation returns the id as a string (parsed from the Location
    // header); the follow-up ops require a number, so coerce here.
    conversationId = Number(created.parsed.conversationId ?? created.parsed.id);
    console.log('conversationId =', conversationId);
  }
  if (!conversationId || Number.isNaN(conversationId)) throw new Error('No usable conversationId; cannot continue.');

  // 3. Internal note (no email).
  show('createNote', await call('createNote', {
    conversationId, text: `Internal note from 2.x smoke test (${stamp}).`,
  }));

  // 4. DRAFT reply, no explicit customer → exercises the primaryCustomer fallback
  //    (the exact bug that was fixed) against the real API. draft:true = no email.
  show('createReply (draft, primaryCustomer fallback)', await call('createReply', {
    conversationId, text: `Draft reply from 2.x smoke test (${stamp}). Not sent.`, draft: true,
  }));

  if (process.env.DELETE_AFTER === 'true') {
    // 5. Delete it (cleans up after the test — no leftover ticket).
    show('deleteConversation', await call('deleteConversation', { conversationId }));
    console.log(`\n🎉 Live write path verified end-to-end. Ticket ${conversationId} created and DELETED.`);
  } else {
    // 5. Close it.
    show('updateConversationStatus (closed)', await call('updateConversationStatus', {
      conversationId, status: 'closed',
    }));
    console.log(`\n🎉 Live write path verified end-to-end. Ticket ${conversationId} created and closed.`);
  }
}

main().catch((err) => { console.error('\nFATAL:', err.message); process.exit(1); });
