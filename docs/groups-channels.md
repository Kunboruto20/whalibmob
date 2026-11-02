# Groups, Communities & Channels

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Groups

### Create a Group

Returns the same metadata object as `getGroupMetadata` (jid, subject, participants, etc.).

```js
const group = await client.createGroup('My Group', [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])
console.log('created', group.jid)       // '120363000000000000@g.us'
console.log('subject', group.subject)   // 'My Group'
console.log('members', group.participants.map(p => p.jid))
```

### Add / Remove or Demote / Promote

Each of these returns one result per participant — the ones that went through
and the ones that did not. The server decides every participant separately, so a
call that half worked tells you which half and why.

```js
const groupJid = '120363000000000000@g.us'

const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok) console.log('added', r.jid)
  else      console.log('failed', r.jid, r.status, r.needsInvite ? '(invite instead)' : '')
}

await client.removeGroupParticipants(groupJid,  ['919634847671'])
await client.promoteGroupParticipants(groupJid, ['919634847671'])
await client.demoteGroupParticipants(groupJid,  ['919634847671'])
```

Each result looks like this:

```js
{
  jid:         '919634847671@s.whatsapp.net',
  status:      '403',        // '200' when the action went through
  error:       403,          // null on success
  ok:          false,        // getter: error == null
  admin:       null,         // 'admin' | 'superadmin' | null
  phoneNumber: '919634847671@s.whatsapp.net',
  lid:         '112713111982325@lid',   // when the server told us one
  displayName: null,
  // Only on a refused add: the code a personal invitation is built from.
  addRequest:  { code: 'AbCdEfGh', expiration: 1790000000 },
  needsInvite: true          // getter: true when addRequest holds a code
}
```

The common error codes are `403` (their privacy settings do not allow it),
`404` (not on WhatsApp), `408` (not a member), `409` (already a member) and
`401` (you are not allowed to do this).

> [!TIP]
> A result object stringifies to its JID, so `results.join(', ')` and
> `String(results[0])` read exactly as they did when these methods returned a
> plain list of JID strings.

### Change Subject

```js
await client.changeGroupSubject('120363000000000000@g.us', 'New Group Name')
```

### Change Description

```js
await client.changeGroupDescription('120363000000000000@g.us', 'This is the group description')
```

### Change Settings

```js
// setting: 'edit_group_info' | 'send_messages' | 'add_participants' | 'approve_participants'
// policy:  'admins' | 'all'

await client.changeGroupSetting('120363000000000000@g.us', 'send_messages',   'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'edit_group_info', 'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'add_participants', 'all')
```

### Leave a Group

```js
await client.leaveGroup('120363000000000000@g.us')
```

### Get Invite Code

```js
const link = await client.queryGroupInviteLink('120363000000000000@g.us')
// e.g. 'https://chat.whatsapp.com/AbCdEfGhIjK'
console.log(link)
```

### Revoke Invite Code

```js
await client.revokeGroupInvite('120363000000000000@g.us')
```

### Join Using Invitation Code

> [!NOTE]
> Pass only the code portion — do not include `https://chat.whatsapp.com/`

```js
const jid = await client.acceptGroupInvite('AbCdEfGhIjK')
console.log('joined', jid)
```

### Query Invite Info from Link

Fetch a group's metadata from an invite code or full URL **without** joining the group. Useful for displaying a preview to the user before they confirm.

```js
// bare code
const info = await client.queryGroupInviteInfo('AbCdEfGhIjKlMnOpQrStUv')

// or pass the full URL — the code is extracted automatically
const info = await client.queryGroupInviteInfo('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv')

console.log(info)
// {
//   jid:          '120363000000000000@g.us',
//   subject:      'My Group',
//   creator:      '919634847671@s.whatsapp.net',
//   creation:     1705315800,   // Unix timestamp
//   description:  'Group description here',
//   participants: [
//     { jid: '919634847671@s.whatsapp.net', role: 'admin' },
//     { jid: '12345678901@s.whatsapp.net',  role: 'member' }
//   ]
// }
```

### Fetch All Groups

Returns an array of metadata objects for every group you are a member of. Each object has the same shape as `getGroupMetadata`.

```js
const groups = await client.fetchAllGroups()
for (const g of groups) {
  console.log(g.jid, g.subject, g.participants.length + ' members')
}
```

### Query Metadata

```js
const meta = await client.getGroupMetadata('120363000000000000@g.us')
console.log(meta.subject, meta.participants.length + ' members')
```

```js
{
  jid:             '120363000000000000@g.us',
  subject:         'My Group',
  size:            57,            // the server's own count
  creation:        1705315800,
  creator:         '919634847671@s.whatsapp.net',
  subjectTime:     1705315900,
  subjectBy:       '919634847671@s.whatsapp.net',
  description:     'Group description here',
  descriptionId:   'DESC1',       // echoed back as `prev` on the next edit
  descriptionBy:   '919634847671@s.whatsapp.net',
  descriptionByPn: '919634847671@s.whatsapp.net',
  descriptionTime: 1705315950,
  ephemeral:       86400,         // 0 when disappearing messages are off
  onlyAdminsSend:  false,
  onlyAdminsEdit:  false,
  joinApprovalMode: true,         // new members need an admin's approval
  memberAddMode:   'admin_add',   // 'admin_add' | 'all_member_add' | null
  isCommunity:         false,
  isCommunityAnnounce: false,
  defaultMembershipApprovalMode: null,   // communities only
  linkedParent:    null,          // the community this group belongs to
  isIncognito:     false,         // members' phone numbers hidden from each other
  isSuspended:     false,         // the group has been taken down
  notify:          'My Group',
  creatorPn:       '919634847671@s.whatsapp.net',
  creatorUsername: null,
  creatorCountry:  'IN',
  subjectByPn:     '919634847671@s.whatsapp.net',
  subjectByUsername: null,
  participantVersion: 'PV1',      // bumped when the member list changes
  announceVersion:    'AV1',      // bumped when the announce flag changes
  addressingMode:  'lid',         // 'lid' | 'pn'
  participants: [
    {
      jid:          '112713111982325@lid',
      role:         'admin',      // 'admin' | 'superadmin' | 'member'
      isAdmin:      true,
      isSuperAdmin: false,
      phoneNumber:  '919634847671@s.whatsapp.net',
      lid:          '112713111982325@lid',
      displayName:  null,
      username:     null
    }
  ]
}
```

Both addresses are filled in on every participant whichever way round the server
named them, so you never have to resolve a LID by hand to know who somebody is.

### Get Request Join List

```js
const pending = await client.queryGroupPendingParticipants('120363000000000000@g.us')

for (const r of pending) {
  console.log(r.jid, 'asked at', new Date(r.requestedAt * 1000).toISOString())
}
```

Each entry is `{ jid, requestedAt }` — `requestedAt` is unix seconds, or `0` when
the server did not say. Like the participant results, an entry stringifies to its
JID.

### Approve / Reject Request Join

The second parameter is a boolean: `true` to approve, `false` to reject. The
return value is the same list of per-participant results the add/remove calls
give you.

```js
// approve join requests
const done = await client.approveGroupParticipants('120363000000000000@g.us', true, [
  '919634847671@s.whatsapp.net'
])
console.log(done.filter(r => !r.ok))   // whoever could not be let in, and why

// reject join requests
await client.approveGroupParticipants('120363000000000000@g.us', false, [
  '919634847671@s.whatsapp.net'
])
```

### Personal Invitations

An invite link is public — anyone holding it can join. A personal invitation is
the other kind: minted for one named person, and the only way into a group for
somebody whose privacy settings stop them from being added outright.

The whole flow starts with a refused add. When the server turns a participant
away for that reason it hands back a code, which travels to them as a message
they can tap.

```js
const groupJid = '120363000000000000@g.us'

// add whoever can be added, and invite whoever cannot — in one call
const results = await client.addGroupParticipantsOrInvite(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok)              console.log('added', r.jid)
  else if (r.invited)    console.log('invited', r.jid)
  else                   console.log('failed', r.jid, r.status, r.inviteError || '')
}
```

Or drive it yourself, if you want to decide who gets an invitation:

```js
const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net'
])

for (const r of results.filter(x => x.needsInvite)) {
  await client.sendGroupInvite(r.jid, groupJid,
    r.addRequest.code, r.addRequest.expiration,
    { caption: 'Come join us' })
}
```

`sendGroupInvite(to, groupJid, code, expiration, opts)` accepts
`{ groupName, caption, jpegThumbnail, isCommunity, id, contextInfo }`. The group
name is filled in from the group's own metadata when you do not supply one.

On the receiving side, an invitation arrives as an ordinary `message` event whose
`decoded.type` is `'groupInvite'`:

```js
client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || d.type !== 'groupInvite') return

  // look before you leap — this does not join anything
  const info = await client.queryGroupInviteMessageInfo(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log(info.subject, info.size + ' members')

  // and accept it
  const jid = await client.acceptGroupInviteMessage(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log('joined', jid)
})
```

A decoded invitation carries `{ groupJid, inviteCode, inviteExpiration,
groupName, jpegThumbnail, caption, isCommunity }`.

To withdraw an invitation you sent before it is used:

```js
await client.revokeGroupInviteForParticipant(groupJid, '919634847671')
```

An expired or already-spent invitation throws rather than resolving to nothing,
so the two cases are easy to tell apart.

### Toggle Ephemeral in Group

```js
await client.changeEphemeralTimer('120363000000000000@g.us', 86400)  // 1 day
await client.changeEphemeralTimer('120363000000000000@g.us', 0)      // off
```

## Communities

WhatsApp Communities are a superset of groups — a parent container that can hold multiple linked
sub-groups plus an automatic general-chat group.

### Create a Community

```js
const community = await client.createCommunity('My Community', 'A place for discussion')
// community.jid  — e.g. 120363000000000001@g.us
```

### Deactivate / Delete a Community

```js
await client.deactivateCommunity('120363000000000001@g.us')
```

### Link Groups into a Community

```js
const linked = await client.linkGroupsToCommunity(
  '120363000000000001@g.us',          // community JID
  ['120363000000000002@g.us',         // group JIDs to link
   '120363000000000003@g.us']
)
```

### Unlink a Group from a Community

```js
await client.unlinkGroupFromCommunity(
  '120363000000000001@g.us',   // community JID
  '120363000000000002@g.us'    // group JID
)
```

## Newsletters (Channels)

Newsletters are one-to-many broadcast channels.  Only the owner can post; anyone can subscribe.

### Create a Newsletter

```js
const nl = await client.createNewsletter('Tech News', 'Daily updates on tech')
// nl.jid — e.g. 120363000000000004@newsletter
```

### Join / Leave a Newsletter

```js
await client.joinNewsletter('120363000000000004@newsletter')
await client.leaveNewsletter('120363000000000004@newsletter')
```

### Query Newsletter Metadata

```js
const meta = await client.queryNewsletterMetadata('120363000000000004@newsletter')
// { jid, name, description, subscriberCount }
```

### Update Newsletter Description

```js
await client.changeNewsletterDescription('120363000000000004@newsletter', 'New description here')
```

### Post a Text Update to Your Newsletter

```js
await client.sendNewsletterText('120363000000000004@newsletter', 'Breaking: WhatsApp adds polls!')
```

## Business Profile

Query the public business profile of any WhatsApp Business account:

```js
const bp = await client.queryBusinessProfile('919634847671')
if (bp) {
  console.log(bp.category)     // e.g. "Software & IT Services"
  console.log(bp.email)        // business email (if set)
  console.log(bp.website)      // business website (if set)
  console.log(bp.address)      // physical address (if set)
  console.log(bp.description)  // business description (if set)
}
// Returns null if the number is not a WhatsApp Business account
```

---

## WhatsApp IDs

- Individual contacts: `[countrycode][number]@s.whatsapp.net`
  - Example: `919634847671@s.whatsapp.net`
- Groups: `[groupid]@g.us`
  - Example: `120363000000000000@g.us`
- Status broadcast: `status@broadcast`
- Broadcast lists: `[timestamp]@broadcast`

> [!NOTE]
> Phone numbers must include the country code without the `+` prefix.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
