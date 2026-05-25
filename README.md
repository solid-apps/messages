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

## Delivery (append-ACL)

Sending does two things: it **records** the message in your own thread-with-them
container, and it **delivers** by POSTing the message to the recipient's pod at
`/private/chats/<base64url(your WebID)>/` — a container they opened for you.

"Opening a channel" for a contact means writing a `.acl` on your
`/private/chats/<them>/` container that grants **their WebID `acl:Append`** (and
you full control). The app does this automatically when you open a conversation,
so replies can be delivered back to you. Append-only means a peer can drop
messages in but can't read your copy or anything else private.

Verified against JSS 0.0.201: a granted WebID can append (201), anonymous is
denied (401), the sender can't read the container (403), and the grant is scoped
to that one container (403 elsewhere).

**Reachability caveat:** delivery needs *both* pods to be internet-reachable
with globally-resolvable WebIDs + OIDC issuers. On a `localhost`-only pod (e.g.
the Android app) delivery no-ops — the message is still saved locally — until
the pod is hosted with a real domain.

## License

AGPL-3.0-only.
