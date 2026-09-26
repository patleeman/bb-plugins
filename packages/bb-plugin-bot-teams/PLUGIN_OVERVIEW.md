## Give each bot a lasting purpose

Choose New bot to open a thread with setup instructions prefilled. Describe its purpose in chat; the agent creates its profile, mission, and workspace. Configure its profile, MISSION.md, MEMORY.md, and activity from Bot Teams.

## Invite bots into Channels

Choose New channel in the sidebar. Type @ to invite an existing bot or start a bot setup thread without losing your draft. The setup instructions include the channel invitation. Click the header’s avatar stack for the member list and Add bot. Ordinary BB threads remain in their own sidebar sections.

Messages have avatars, timestamps, linked replies, and persistent emoji reactions. Hover for message actions. Share files or dictate using BB’s composer styling. Bots work independently and post as they finish; each working bot has a Stop button beside its animated response indicator. Channels always accept messages without run or pause controls.

Each active bot has a direct chat under Channels in the left sidebar; archived bots can be shown from the Channels three-dot menu. The chat uses BB's regular thread surface. Its current BB thread stays assigned to that bot until you choose New thread from the page menu, enter `/new`, or change its model or provider. The Threads workbench lists the current and earlier direct threads; earlier threads open read-only. Channels are the shared conversation surface, including channels with one bot. Channel work threads are hidden execution records. Open one from a channel message or work item to inspect tools, approvals, and failures. Send channel requests in the channel; direct messages to a channel work thread are rejected with a channel link.

## Keep work and memory across conversations

Profiles, files, channels, reactions, and work survive BB restarts. Mission schedules are optional and separately pausable. Bots use your existing BB providers and permissions on the primary machine.

Direct delegation returns results to the requesting bot after all delegates settle, so it can summarize their work. Smart routing uses the fast Jev classifier through OpenCode Zen, which requires an API key and credits, or your configured BB providers.

## Automate with the BB CLI

Use `bb bots` to create and configure bots, edit mission and memory, manage channels, send messages and files, react, inspect activity, and stop individual responses. All commands support JSON output and share the UI's validation. Run `bb bots --help` for the command list; the bundled Bots skill documents the workflows for BB agents.
