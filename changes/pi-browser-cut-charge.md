---
packages: @parcha/pi-browser
kind: feature
---
`BrowserExtensionHandle.charge(conversation, context)` bills each open session of a conversation through now, not final. A session counts as open when it is live, held, or releasing (its release asked and not yet confirmed). The charge and the session's `chargedThrough` move in one commit, and it resolves to the number of sessions charged. A host that stops waiting on a session's release uses it to book the time known so far. The release's own charge, when it lands, bills only the time after that, so a cut charge followed by the final charge books what one uninterrupted session books, the provider's minimum included. A charge through a time before the session's `chargedThrough` bills nothing, never a negative amount, and reports the difference in seconds as `SessionCharge.overbookedS`. That happens when the release was confirmed before an earlier charge that billed past it. A session billed final is never billed again.
