# Channel attention notifications

Bot Teams keeps decision, blocker, and important update requests on their channel messages. Creating one adds a durable attention marker and queues a push event. The notification resolver returns a standard `turn-finished` event with a channel message path, so tapping the alert opens the request in the channel. It does not create a pending interaction, open a question form, or reveal the bot's DM.

The owner replies in the channel composer. **Acknowledge** and **Snooze 1 hour** remain available on the request. Reading a channel does not clear it. Reopening a snoozed or acknowledged request queues a fresh push event. **Attention push notifications** controls these alerts; delivery also respects **Settings → Push notifications**. The installed BB build does not expose the shared `notifications.enqueue` RPC, so queued events cannot reach the phone until BB provides it. The channel request remains visible and usable.

`@user` mentions and `bots_channel_notify` create the same attention marker and push event. FYI updates remain on their channel messages. Old answers that were already queued by the retired question form continue through the durable reply outbox and remain discardable from the channel if delivery fails; no new replies are collected through a notification prompt.

The real channel request surface is captured in [channel-attention.png](../assets/channel-attention.png). The channel's highlight and sidebar bell are captured in [channel-ping-highlight.png](../assets/channel-ping-highlight.png).
