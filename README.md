# dsh-superagent

当前 AI 盒子个人试点的局域网工作台：`http://192.168.0.158:3084/orchestrator/loom/`，同网段免登录访问；独立网关、权限边界及维护见 [部署记录](docs/SERVER_DEPLOYMENT.md)。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Personal assistant fork

This fork extends the prototype toward Loom, an everyday work assistant with Feishu integration and user intervention. Personal mode remains the default. The same product now also has an optional [shared-group mode](docs/GROUP_MODE.md): one bot, one selected group and an explicitly selected set of masters, reusing the same Runtime, tasks, reports and UI. General team spaces and cross-instance A2A remain deferred. See [project scope](docs/PROJECT.md), [planned work and principles](docs/ROADMAP.md), and [development instructions](AGENTS.md).

The implementation supports Feishu-only setup, office summaries, exact CSV aggregation with source snapshots, and task continuation and result delivery. Personal deployments have durable task pause and managed handover controls; these are not an OS sandbox. Owner-authenticated private task lists, saved reports and TXT exports have passed real message acceptance. New work adds immutable report versions, source hashes, owner edits with conflict checks, quoted-message controls and mail confirmation, and optional tool-free private summary drafts with bounded budgets. Card 2.0 rendering and callback authorization are implemented, but the active app's pending publication currently blocks adding the required callback; buttons remain disabled. Mail supports owner-reviewed reports through Feishu or a private 163 SMTP bridge. The current 163 deployment has passed private preview, explicit confirmation, SMTP acceptance and user-confirmed mailbox receipt; enterprise-mail sending is deferred. See the [chat commands and limits](docs/FEISHU_ASSISTANT.md), [acceptance evidence](docs/PERSONAL_ACCEPTANCE.md), [personal setup guide](docs/PERSONAL_SETUP.md) and [Feishu product plan](docs/FEISHU_PRODUCT.md). Loom now offers default/per-task delivery: a fixed report file to Feishu, local retention, or owner-authorized mail to the verified bound mailbox. Explicit task-local Markdown/text reports are snapshotted; arbitrary workspace attachments remain deferred. Original group threads and on-demand private queries remain the primary interaction. A standalone Feishu workspace, arbitrary workspace-file retrieval, live collaborative merging and content-filtered email rules are deferred.

Company-mode SQL/native-state development now includes proved Linux crash recovery, referenced native file/image archives, pinned full-role capability filtering, and offline profile preparation with ordered shutdown. ARM AI-box isolation checks and real-history migration/rollback results are recorded in [B6](docs/work-packages/DSH_STATE_B6.md). The AI-box pilot now runs the SQL/native-state company entry with a loopback-only personal console, currently requiring no login; a real unmentioned group task and original-thread Word delivery have passed file read-back after fixing nested preset imports. Feishu OAuth acceptance remains separate. See [current deployment and login steps](docs/SERVER_DEPLOYMENT.md).

A local Linux read-only Runner now provides explicit directory grants, signed read/glob/literal-grep requests and durable SQLite receipts, with real-process crash tests and a compiled CLI smoke using fictional files. The company-side trusted gateway core now also covers one-time pairing, StateStore-backed device registration/revocation, device-key connections, heartbeat and request deduplication, and the codebase has a TLS 1.3 active Runner transport with Ed25519 handshake and reconnect tests. `CompanyServer` can opt into the TLS listener and exposes administrator/CSRF-protected pairing, registration, device-list and revoke routes. `CompanyRemoteExecution` now connects the company Worker to `ExecutionRouter`; an AI-box acceptance has read a fictional remote file through Gateway/TLS/Runner without local fallback. See [C2 scope](docs/work-packages/GATEWAY_RUNNER_C2.md), [C3 gateway core](docs/work-packages/GATEWAY_RUNNER_C3.md) and [C4 acceptance](docs/work-packages/GATEWAY_RUNNER_C4_ACCEPTANCE.md).

## Setup

DSH workers can now request a [Word report](docs/DOCUMENT_ARTIFACTS.md) through the controlled report tool. Loom renders actual OOXML, snapshots immutable file bytes and exposes versioned downloads and original-thread attachments; ordinary server shell/file access remains restricted in shared mode.

Shared-group mode also supports an explicit [recording-to-minutes delegation](docs/MEETING_RECORDINGS.md): ask in the original thread, require a master's confirmation, transcribe with the configured Bailian ASR (or optional local connector), and deliver a versioned report. A live 40-minute group recording has passed confirmation, cloud transcription, original-thread file delivery and a subsequent detailed revision; recognition accuracy and content quality still require human review.

A dedicated Ubuntu ARM64 company pilot now runs under its own OS account and systemd service, with loopback-only administration and separately configured bot credentials. Server/model recovery and a live single-master group path have passed: unmentioned task admission, versioned reports, original-thread attachments and control persistence. Multi-user acceptance and enterprise resource connectors remain separate. See [server deployment and acceptance](docs/SERVER_DEPLOYMENT.md) and the [service template](examples/loom-server.service).

Cross-device discussion continuity targets a single owner. The default Feishu connector uses explicit user authorization, a dedicated cloud-drive folder, immutable batches and read-only MCP; the account/transfer/MCP paths have isolated acceptance, while live account permissions and real two-computer acceptance remain separate. It reuses an installed, configured Feishu CLI and does not yet provide fresh-machine zero-configuration login. The existing self-hosted connector remains under Advanced settings, marked “待验证” (pending verification). Both require explicit project/AI grants and do not control remote agents or migrate native session databases. Setup, boundaries and evidence: [Device sync](docs/DEVICE_SYNC.md).

Desktop-owned assistants prepare a separate sync user profile from the existing app's file credential reference when login is requested, leaving bot strict mode unchanged. Configuration, missing CLI and connection failures are reported separately. Manual deployments still require their own matching user CLI configuration.

The supplied Loom UI is available as a local personal workspace backed by this same Runtime. Build and access instructions: [Loom integration](docs/LOOM_SETUP.md).
Worker capability assembly and the boundary between DSH tools and Loom authorization are documented in [Worker capabilities](docs/WORKER_CAPABILITIES.md).
The Linux, macOS and native Windows desktop clients connect to the personal runtime, with an independent window, tray and local connection guide. Windows runs its assistant in native Windows processes and needs no WSL; 0.4.1 fixes returning to edit a failed first-run setup. macOS ZIPs have local signatures; the Windows ZIP is unsigned. Build, verification status and installation: [Loom Desktop](docs/DESKTOP.md).
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

Company-server development now has an opt-in [external-state product entry and migration guide](docs/work-packages/COMPANY_PRODUCT.md), deployed on the existing AI box when explicitly switched. It reuses the authorized single-group scope; the default personal Runtime is unchanged. Native DSH Session storage and device execution remain separate work packages.

Native DSH state work has an opt-in [B1 SQL persistence provider](docs/work-packages/DSH_STATE_B1.md), [B3 company ownership integration](docs/work-packages/DSH_STATE_B3.md) and [B4 SQL metadata/text-history migration](docs/work-packages/DSH_STATE_B4.md). The [B5 task-recovery integration](docs/work-packages/DSH_STATE_B5.md) exercises real rc.3 AgentLoop/preset/permission/pi-ai modules through orderly restart, human revisions and model-selection recovery. These share application/native authority, guard Agent lifecycles, preserve fixed inputs and require verified drain before handover. SQLite/PostgreSQL contracts and actual rc.3 JSONL/JSON archive → SQL → fresh WorkspaceRegistry recovery are tested without model inference. B6 adds bounded native file/image migration and same-Linux-host process-exit recovery; the AI-box company provider has been switched after explicit authorization. Arbitrary plugin recovery, directory migration and actual Feishu OAuth acceptance remain separate.

C1 development adds an opt-in [read-only remote protocol, routing boundary and simulator](docs/work-packages/GATEWAY_RUNNER_C1.md). The active Runtime still refuses Runner targets; device identity, Linux execution, persistent remote receipts and two-machine acceptance remain C2–C4 work.

An opt-in [multi-group company host](docs/MULTI_GROUP.md) now reuses the same single-group authorization model across explicitly registered, isolated workspaces: one bot connection, separate actual DSH roots/SQL providers, shared bounded compute, and authenticated workbench group management. SQLite/PostgreSQL contracts and real rc.3 two-group synthetic task/restart acceptance are covered; production enrollment and real multi-member acceptance remain separate.
