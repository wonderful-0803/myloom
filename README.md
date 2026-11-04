# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Personal assistant fork

This fork extends the prototype toward a single-user personal assistant for everyday office work, with Feishu integration and user intervention. See [project scope](docs/PROJECT.md), [planned work and principles](docs/ROADMAP.md), and [development instructions](AGENTS.md). Team collaboration and cross-instance A2A are deferred.

The implementation supports Feishu-only setup, office summaries, exact CSV aggregation with source snapshots, and task continuation and result delivery. Personal deployments have durable task pause and managed handover controls; these are not an OS sandbox. Owner-authenticated private task lists, saved reports and TXT exports have passed real message acceptance. New work adds immutable report versions, source hashes, owner edits with conflict checks, quoted-message controls and mail confirmation, and optional tool-free private summary drafts with bounded budgets. Card 2.0 rendering and callback authorization are implemented, but the active app's pending publication currently blocks adding the required callback; buttons remain disabled. Mail supports owner-reviewed reports through Feishu or a private 163 SMTP bridge. The current 163 deployment has passed private preview, explicit confirmation, SMTP acceptance and user-confirmed mailbox receipt; enterprise-mail sending is deferred. See the [chat commands and limits](docs/FEISHU_ASSISTANT.md), [acceptance evidence](docs/PERSONAL_ACCEPTANCE.md), [personal setup guide](docs/PERSONAL_SETUP.md) and [Feishu product plan](docs/FEISHU_PRODUCT.md). Loom now offers default/per-task delivery: a fixed report file to Feishu, local retention, or owner-authorized mail to the verified bound mailbox. Explicit task-local Markdown/text reports are snapshotted; arbitrary workspace attachments remain deferred. Original group threads and on-demand private queries remain the primary interaction. A standalone Feishu workspace, arbitrary workspace-file retrieval, live collaborative merging and content-filtered email rules are deferred.

## Setup

The supplied Loom UI is available as a local personal workspace backed by this same Runtime. Build and access instructions: [Loom integration](docs/LOOM_SETUP.md).
The Linux and macOS desktop clients connect to that same personal runtime, with an independent window, tray and local connection guide. macOS ZIPs are internal builds with local signatures; Developer ID signing and notarization remain separate. Build, verification status and installation: [Loom Desktop](docs/DESKTOP.md).
Its first-run wizard can also prepare an independent assistant using the existing local engine: model verification, bot credentials, owner/chat scope and explicit startup. It does not import the existing assistant's credentials or history, and checks for duplicate bot listeners. Installing all dependencies on a fresh machine remains separate.

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
