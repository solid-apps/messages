# messages

A minimal **SMS-style chat app** for a Solid pod — one 2-party thread per
contact. Distinct from the [inbox](https://github.com/solid-apps/inbox)
("email"): conversations, not a mailbox.

- **Conversation list** + **thread view** (bubbles), composer at the bottom.
- One thread per person, keyed by their **WebID**.
- The roster is your **contacts** that carry a WebID (`vcard:url`); start a new
  chat by picking a contact or pasting a WebID.
- Private (owner-only) → sign in (login pill, bottom-right).

## Storage

Threads live under `<pod>/private/chats/<key>/`, one JSON-LD ActivityStreams
`Note` per message:

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Note",
  "content": "hey",
  "attributedTo": "https://me.example/profile/card#me",
  "to": "https://alice.example/profile/card#me",
  "published": "2026-05-25T12:00:00Z"
}
```

### Why `<key>` is `base64url(canonical WebID)`

A WebID is a URL — it can't be a folder name raw. We **canonicalize** it
(lowercase scheme + host, trim — so `Alice.example/…` and `alice.example/…`
don't become two threads) and then **base64url**-encode it. base64url is
reversible, so listing `/private/chats/` and decoding the keys gives the roster
back — no side-index needed. Contacts supplies the display name.

## Status

**v1 stores your side locally.** Sending appends to the per-contact thread on
your pod; it doesn't yet *reach* the other person. Delivery is a separate
transport layer (per-contact append-ACL, Nostr DM, …) that writes into this
same store — deliberately decoupled from where the messages live.

## License

AGPL-3.0-only.
