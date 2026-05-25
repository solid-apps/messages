// messages — SMS-style 2-party chat, one thread per contact.
//
// Threads live under <pod>/private/chats/<base64url(canonical WebID)>/, one
// JSON-LD ActivityStreams Note per message. Private (owner-only) → sign in.
// The roster is your contacts that carry a WebID (vcard:url). The conversation
// list is derived by listing /private/chats/ and decoding the keys back to
// WebIDs — base64url is reversible, so no side-index is needed.
//
// v1 stores YOUR side locally; actually delivering a message to the other
// party is a later transport layer that writes into this same per-contact
// store. So sending appends to the thread; it doesn't reach them yet.

const appEl = document.getElementById('app')
const CHATS = new URL('../../../private/chats/', location.href)  // <pod>/private/chats/
const CONTACTS = new URL('../../contacts/', location.href)       // <pod>/public/contacts/
const AS = 'https://www.w3.org/ns/activitystreams#'

const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)
const myWebId = () => (window.xlogin && window.xlogin.id) || null

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// --- WebID ↔ key encoding ---
// Canonicalize (lowercase scheme+host, trim) so the same person maps to one
// thread, then base64url so it's a safe, reversible container name.
function canonWebId(w) {
  const s = (w || '').trim()
  try { const u = new URL(s); u.protocol = u.protocol.toLowerCase(); u.hostname = u.hostname.toLowerCase(); return u.href } catch { return s }
}
function keyOf(webid) {
  const b64 = btoa(unescape(encodeURIComponent(canonWebId(webid))))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function webidOfKey(key) {
  let b64 = key.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  try { return decodeURIComponent(escape(atob(b64))) } catch { return '' }
}

// --- JSON-LD helpers ---
function ldpContains(doc) {
  const c = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains || []
  return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x['@id'] || x.id)).filter(Boolean)
}
const idOf = (v) => v == null ? '' : (typeof v === 'string' ? v : (Array.isArray(v) ? idOf(v[0]) : (v['@id'] || v.id || '')))
const valOf = (v) => v == null ? '' : (typeof v === 'string' ? v : (Array.isArray(v) ? valOf(v[0]) : (v['@value'] || v['@id'] || '')))
function asField(obj, term) {
  if (obj == null) return undefined
  return obj[term] ?? obj['as:' + term] ?? obj[AS + term]
}

// --- contacts = the directory (WebID → display name) ---
async function loadContacts() {
  const map = new Map()
  try {
    const r = await authFetch(CONTACTS, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return map
    const urls = ldpContains(await r.json()).map((u) => new URL(u, CONTACTS).href)
      .filter((u) => !u.endsWith('/') && !u.split('/').pop().startsWith('.'))
    for (const u of urls) {
      try {
        const cr = await authFetch(u, { headers: { Accept: 'application/ld+json' } })
        if (!cr.ok) continue
        const d = await cr.json()
        const url = d['vcard:url'] || d['http://www.w3.org/2006/vcard/ns#url']
        const webid = typeof url === 'string' ? url : idOf(url)
        const fn = d['vcard:fn'] || d['http://www.w3.org/2006/vcard/ns#fn'] || ''
        if (webid) map.set(canonWebId(webid), valOf(fn) || webid)
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  return map
}

// --- conversations + threads ---
async function listConversations() {
  const r = await authFetch(CHATS, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) return []
  return ldpContains(await r.json())
    .map((u) => new URL(u, CHATS).href)
    .filter((u) => u.endsWith('/'))
    .map((u) => { const key = u.replace(/\/$/, '').split('/').pop(); return { key, url: u, webid: webidOfKey(key) } })
    .filter((c) => c.webid)
}

function parseMsg(d, url) {
  return {
    url,
    content: valOf(asField(d, 'content')),
    from: canonWebId(idOf(asField(d, 'attributedTo') ?? asField(d, 'actor'))),
    published: valOf(asField(d, 'published'))
  }
}

async function loadThread(threadUrl) {
  const r = await authFetch(threadUrl, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) return []
  const urls = ldpContains(await r.json()).map((u) => new URL(u, threadUrl).href)
    .filter((u) => !u.endsWith('/') && !u.split('/').pop().startsWith('.'))
  const msgs = []
  for (const u of urls) {
    try { const mr = await authFetch(u, { headers: { Accept: 'application/ld+json' } }); if (mr.ok) msgs.push(parseMsg(await mr.json(), u)) } catch { /* skip */ }
  }
  msgs.sort((a, b) => (a.published || '').localeCompare(b.published || ''))
  return msgs
}

async function sendMsg(webid, body) {
  const thread = new URL(keyOf(webid) + '/', CHATS).href
  const now = new Date().toISOString()
  const fname = now.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7) + '.jsonld'
  const doc = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Note', content: body, attributedTo: myWebId(), to: canonWebId(webid), published: now
  }
  const target = new URL(fname, thread).href
  const put = () => authFetch(target, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(doc) })
  let res = await put()
  if (!res.ok && (res.status === 404 || res.status === 409)) {
    // Create the chats container + this thread, then retry once.
    await authFetch(CHATS, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: '' }).catch(() => {})
    await authFetch(thread, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: '' }).catch(() => {})
    res = await put()
  }
  if (!res.ok) throw new Error(`send failed (${res.status})`)
}

// --- UI ---
let CONTACTS_MAP = new Map()
// Deep-link: ?to=<webid> (e.g. from the contacts app's Message button) opens
// that conversation directly.
let OPEN = (() => { const t = new URLSearchParams(location.search).get('to'); return t ? canonWebId(t) : null })()

function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2400)
}
const nameOf = (webid) => CONTACTS_MAP.get(canonWebId(webid)) || webid.replace(/#.*$/, '').replace(/\/$/, '').split('/').slice(-2).join('/')
const when = (iso) => { const d = iso && new Date(iso); return (d && !isNaN(d)) ? d.toLocaleString() : '' }

async function renderList() {
  appEl.innerHTML = '<h1>Messages</h1><p class="sub muted">Loading…</p>'
  CONTACTS_MAP = await loadContacts()
  let convos = []
  try { convos = await listConversations() } catch { /* none */ }
  const haveKeys = new Set(convos.map((c) => canonWebId(c.webid)))
  const startable = [...CONTACTS_MAP.entries()].filter(([w]) => !haveKeys.has(w))

  appEl.innerHTML = `
    <h1>Messages</h1>
    <p class="sub">${convos.length} ${convos.length === 1 ? 'conversation' : 'conversations'}</p>
    <div class="toolbar"><button class="new">New message</button></div>
    <div class="newpanel" hidden></div>
    <div class="convos"></div>`

  const panel = appEl.querySelector('.newpanel')
  appEl.querySelector('.new').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) renderNewPanel(panel, startable) }

  const list = appEl.querySelector('.convos')
  if (!convos.length) list.innerHTML = '<p class="muted">No conversations yet — start one.</p>'
  convos.sort((a, b) => nameOf(a.webid).localeCompare(nameOf(b.webid)))
  convos.forEach((c) => {
    const row = document.createElement('div')
    row.className = 'convo'
    row.innerHTML = `<span class="avatar">${esc((nameOf(c.webid)[0] || '?').toUpperCase())}</span>
      <span class="who"><span class="name">${esc(nameOf(c.webid))}</span><span class="webid">${esc(c.webid)}</span></span>`
    row.onclick = () => { OPEN = canonWebId(c.webid); render() }
    list.appendChild(row)
  })
}

function renderNewPanel(panel, startable) {
  panel.innerHTML = `
    <input class="to" placeholder="WebID (https://…/profile/card#me)">
    <div class="form-actions"><button class="open">Open chat</button></div>
    ${startable.length ? '<div class="pick-title">From contacts</div>' : ''}
    <div class="picks"></div>`
  const open = (w) => { if (!w) { toast('Enter a WebID'); return } OPEN = canonWebId(w); render() }
  panel.querySelector('.open').onclick = () => open(panel.querySelector('.to').value.trim())
  const picks = panel.querySelector('.picks')
  startable.forEach(([w, name]) => {
    const b = document.createElement('button')
    b.className = 'pick ghost'
    b.textContent = name
    b.onclick = () => open(w)
    picks.appendChild(b)
  })
}

async function renderThread(webid) {
  const me = canonWebId(myWebId())
  appEl.innerHTML = `
    <div class="thread-head">
      <button class="back ghost">←</button>
      <span class="who"><span class="name">${esc(nameOf(webid))}</span><span class="webid">${esc(webid)}</span></span>
    </div>
    <div class="messages"><p class="muted">Loading…</p></div>
    <div class="composer">
      <textarea class="c-body" rows="1" placeholder="Message…"></textarea>
      <button class="c-send">Send</button>
    </div>
    <p class="hint muted">v1 stores your side on your pod; delivery to the other person comes later.</p>`
  appEl.querySelector('.back').onclick = () => { OPEN = null; render() }

  const msgsEl = appEl.querySelector('.messages')
  const paint = async () => {
    let msgs = []
    try { msgs = await loadThread(new URL(keyOf(webid) + '/', CHATS).href) } catch { /* none */ }
    if (!msgs.length) { msgsEl.innerHTML = '<p class="muted">No messages yet. Say hi.</p>'; return }
    msgsEl.innerHTML = ''
    msgs.forEach((m) => {
      const b = document.createElement('div')
      b.className = 'bubble ' + (m.from === me ? 'mine' : 'theirs')
      b.innerHTML = `<div class="text"></div><div class="time">${esc(when(m.published))}</div>`
      b.querySelector('.text').textContent = m.content
      msgsEl.appendChild(b)
    })
    msgsEl.scrollTop = msgsEl.scrollHeight
  }
  await paint()

  const body = appEl.querySelector('.c-body')
  const send = appEl.querySelector('.c-send')
  send.onclick = async () => {
    if (!loggedIn()) { toast('Sign in first (login pill, bottom-right)'); return }
    const text = body.value.trim()
    if (!text) return
    send.disabled = true
    try { await sendMsg(webid, text); body.value = ''; await paint() }
    catch (e) { toast(String(e.message || e)) }
    finally { send.disabled = false }
  }
}

async function render() {
  if (!loggedIn()) {
    appEl.innerHTML = '<h1>Messages</h1><div class="signin-note">Your messages are private — sign in (login pill, bottom-right) to read and send.</div>'
    return
  }
  if (OPEN) await renderThread(OPEN)
  else await renderList()
}

render()
document.addEventListener('xlogin', render)
document.addEventListener('xlogout', render)
