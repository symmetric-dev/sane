# Linear API, SDK, authentication, and workspace-scoped SANE issue UI

Research date: October 5, 2026. Official documentation and the official `linear/linear` repository were fetched during this research. Repository `master` and documentation are mutable; this is not a claim about a release date. No authenticated API calls, code edits, tests, or browser verification were performed.

## Can users view and edit canonical Linear issues inside SANE, and which fields should the MVP expose?

### Takeaway

Yes, technically: Linear's public GraphQL API supports querying issues and creating/updating them; the official TypeScript SDK exposes the same operations. SANE can implement its own issue list/detail/editor without navigating to Linear for routine work, while Linear remains the canonical remote store. This technical finding is not blanket legal approval for a competing/resold issue product; see the licensing section below. — [GraphQL](https://linear.app/developers/graphql); [SDK](https://linear.app/developers/sdk); [Terms](https://linear.app/terms)

### Cited Findings

- The public endpoint is `https://api.linear.app/graphql`, supports introspection, and is the API Linear uses internally. Official documentation supplies `teams`, `team(id) { issues }`, `issue(id)` (including readable identifiers such as `BLA-123`), `issueCreate(input)`, and `issueUpdate(id,input)` examples. API mutations are observed in real time by Linear clients. — [GraphQL](https://linear.app/developers/graphql); [API and Webhooks](https://linear.app/docs/api-and-webhooks)
- The repository's schema explicitly includes `Query.organization`, `Query.teams`, `Query.team`, `Query.issues(filter,first,after,orderBy,...)`, `Query.issue(id)`, `Query.workflowStates`, `Query.issueLabels`, `Query.projects`, `Query.cycles`, and `Query.users`. `IssueFilter` includes `team`, `project`, `state`, `assignee`, `labels`, and `updatedAt`. An issue belongs to exactly one team; a project's `teams` connection supports projects spanning teams. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- The following field mapping is verified in both `IssueCreateInput` and `IssueUpdateInput`; comments are separate entities/mutations, **not** a field in those issue inputs. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)

| UI field | Read field | Create/update input | Recommended MVP treatment |
|---|---|---|---|
| Title | `title` | `title: String` | Include editable; require a nonempty title in SANE's creation form. |
| Description | `description` | `description: String` (Markdown) | Include editable Markdown; preserve content rather than silently converting to a lossy editor. |
| Status | `state { id name type color position }` | `stateId: String` | Include editable; load states for the issue's team, never hardcode a universal status set. |
| Assignee | `assignee { id name }` | `assigneeId: String` | Include editable using permitted, eligible users. |
| Priority | `priority`, `priorityLabel` | `priority: Int` | Include editable: 0 none, 1 urgent, 2 high, 3 medium, 4 low. |
| Labels | `labelIds`, `labels { nodes { id name } }` | `labelIds: [String!]` | Include selecting existing valid labels; defer label administration. |
| Project | `project { id name }` | `projectId: String` | Include selecting an existing compatible project; default from configured workspace mapping if appropriate. Defer project creation/management. |
| Cycle | `cycle { id name }` | `cycleId: String` | Display if set; defer editing unless essential to the team's daily workflow. |
| Estimate | `estimate` (Float, nullable) | `estimate: Int` | Display if set; defer editing until team-specific scales are correctly represented. |
| Due date | `dueDate` | `dueDate: TimelessDate` | Display if set; optional later editing, not required for the first issue UI. |
| Comments | `comments(first,after,...) { nodes { id body ... } }` | `commentCreate({ issueId, body })`, `commentUpdate(id,{ body })` | Include paginated reading and adding comments. Defer editing/deleting threads, reactions, inline comments, and Slack-synced behavior. |
| Identity/context | `id`, `identifier`, `url`, `team`, `updatedAt`, `archivedAt` | Not ordinary editable identity fields | Display identifier/link and freshness; retain remote UUID and organization identity internally. |

The API-read/write columns above are sourced from the [official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql); MVP choices are recommendations/inferences, not Linear requirements. Description Markdown is also explicitly documented in [GraphQL examples](https://linear.app/developers/graphql).

- Schema nuance: `IssueCreateInput.teamId` is non-null; `title` is nullable in the schema because creation can use templates (`templateId`, `useDefaultTemplate`). This is not a recommendation to let SANE create blank-title issues. `IssueUpdateInput.teamId` permits team changes technically, but that introduces status/label/project/cycle compatibility work. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- `IssueUpdateInput` also includes `addedLabelIds` and `removedLabelIds`, useful for changing only selected labels instead of replacing the entire current set with a stale snapshot. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- Status is a team workflow state, not a universal `status` string. `WorkflowStateFilter` supports a team filter and lists types `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, and `duplicate`. Team-specific names/IDs can differ. When `stateId` is omitted at creation, documentation says first state in the team's Backlog category is used, or Triage if that feature is enabled. Do not claim every new issue defaults to Todo. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql); [Creation defaults](https://linear.app/developers/graphql#creating-and-editing-issues)
- The issue estimate's specific scale depends on the team's estimation configuration (for example points or T-shirt sizes); read type is nullable Float while create/update inputs use Int. This is a reason not to present an arbitrary numeric textbox as a universally valid estimate editor. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- Images uploaded into Linear require authentication even when displayed outside Linear. The documentation recommends downloading and self-hosting them when displaying them outside Linear's applications. A Markdown editor/renderer cannot assume all embedded asset URLs are public. — [Asset access](https://linear.app/developers/graphql#accessing-images)

**Schema-verified illustrative GraphQL operations** (constructed from the official schema, not executed against a live account):

```graphql
query WorkspaceIssuePanel($filter: IssueFilter!, $after: String) {
  organization { id name }
  issues(first: 25, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      id identifier title url updatedAt
      state { id name type color }
      team { id name key }
      assignee { id name }
      priority priorityLabel
      project { id name }
      labelIds
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

Example filter variables: `{ "team": { "id": { "eq": "TEAM_UUID" } }, "project": { "id": { "eq": "PROJECT_UUID" } } }`; omit `project` for an explicitly chosen whole-team scope. Filter and connection support: [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).

```graphql
query IssueDetail($id: String!) {
  issue(id: $id) {
    id identifier title description url updatedAt
    team { id name key }
    state { id name type color }
    assignee { id name }
    priority priorityLabel
    project { id name }
    cycle { id name }
    estimate dueDate
    labels(first: 25) { nodes { id name } pageInfo { hasNextPage endCursor } }
    comments(first: 20) {
      nodes { id body createdAt user { id name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}

query TeamStates($teamId: String!) {
  team(id: $teamId) {
    id
    states(first: 50) {
      nodes { id name type color position }
      pageInfo { hasNextPage endCursor }
    }
  }
}

mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title url } }
}

mutation EditIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id title updatedAt state { id name } }
  }
}

mutation AddComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body createdAt } }
}
```

Selections and mutation signatures: [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql). Paginate states/labels/comments if `hasNextPage` is true rather than treating these bounded examples as complete datasets.

**SDK equivalents:** initialize `new LinearClient({ apiKey })` or `new LinearClient({ accessToken })`; use `await client.organization`, `await client.teams()`, `await client.team(teamId)`, `await client.issues({ first: 25, filter: { team: { id: { eq: teamId } } } })`, `await client.issue(issueId)`, `await issue.comments({ first: 20 })`, `await client.createIssue(input)`, `await client.updateIssue(issueId, patch)`, `await client.createComment({ issueId, body })`, and `await client.updateComment(commentId, { body })`. The official generated SDK confirms create/update issue/comment method signatures; official SDK documentation confirms client/model queries, optional variable objects, pagination, and mutation payloads. — [SDK setup](https://linear.app/developers/sdk); [Fetching and modifying](https://linear.app/developers/sdk-fetching-and-modifying-data); [Generated SDK](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_sdk.ts)

### Inferences

- **Recommended scope model:** configure a SANE workspace connection with Linear organization UUID, allowed/selected team UUID(s), and optional project filter/default UUID(s). Repository associations are SANE metadata, not the Linear team's identity. Permit several SANE repositories to share a team or project, and do not infer that an entire team's issue list belongs to one repository. This is a SANE design recommendation based on issue/team/project semantics, not a Linear repository-mapping requirement. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- **Recommended minimum product:** filtered/paginated list with identifier, title, status, assignee, priority, project/labels, and link; detail with Markdown description and comments; create/edit title, description, team-specific status, assignee, priority, existing labels/project; add a comment. Show cycle/estimate/due date if present but defer their editors. Keep an “Open in Linear” escape hatch for richer planning/configuration, not as the only way to update an issue. — [Available operations](https://linear.app/developers/graphql); [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- **Canonical write policy:** send only changed fields to Linear, check mutation success/errors, then replace local displayed values with the returned/refetched remote issue. For labels prefer add/remove deltas; for long descriptions re-read before overwrite if the remote `updatedAt` differs from the editor baseline. Do not promise offline editing or conflict-free collaboration in MVP. These are client design recommendations, not documented server-side compare-and-swap behavior. — [GraphQL errors](https://linear.app/developers/graphql#error-handling); [Update input](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)

### Gaps

- No authenticated issue creation/update was performed. Schema/documentation verification establishes availability and types, not successful mutation under a particular account, team setting, role, or private/shared-issue permission.
- Null-to-clear behavior for every nullable input, estimate validation details, due-date serialized format, and comment ownership/edit permission rules should be checked against the live schema/account before implementing each editor. Avoid assuming all nullable GraphQL fields have identical clearing semantics.
- No concurrency precondition/version parameter was identified in `IssueUpdateInput`; the recommendations above are not an atomic conflict-prevention guarantee. — [Official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)

## What authentication, private-team, licensing, and MCP boundaries apply?

### Takeaway

Use a restricted personal API key for a private/local proof of integration; use per-user OAuth (`actor=user`) for a distributed human-operated SANE editor. SDK MIT licensing covers the client library, not Linear's proprietary service or a right to bypass subscriptions, permissions, or restrictions. The official MCP is an optional agent interface; direct GraphQL/SDK is the clearer foundation for a deterministic issue UI. — [Authentication](https://linear.app/developers/graphql#authentication); [OAuth](https://linear.app/developers/oauth-2-0-authentication); [SDK license](https://github.com/linear/linear/blob/master/LICENSE); [Terms](https://linear.app/terms); [MCP](https://linear.app/docs/mcp)

### Cited Findings

- Personal keys are managed in Account → Security & Access. They can be restricted to permissions **Read, Write, Admin, Create issues, Create comments**, and to specific teams. Admins can disable Members' ability to create keys. Keys otherwise expose the data their user can access. GraphQL key authentication is `Authorization: <API_KEY>` (not the OAuth bearer form). — [API keys and controls](https://linear.app/docs/api-and-webhooks); [GraphQL authentication](https://linear.app/developers/graphql#authentication)
- Linear recommends OAuth for applications other people use. `read` is always present; `write` grants write access; `issues:create` permits creating issues/attachments; `comments:create` permits creating comments; `admin` grants admin endpoints and should not be requested without need. Existing issue edits need `write`, not merely the create-only scopes. A read/comment-only feature can request `read,comments:create`; full panel editing should request `read,write`, without `admin`. — [OAuth scopes](https://linear.app/developers/oauth-2-0-authentication)
- OAuth's default `actor=user` attributes actions to the authorizing human; `actor=app` attributes mutations, including status changes, to an installed app and is intended for agents/service accounts. `createAsUser`/`displayIconUrl` are app-mode creation attribution options, not a reason to share a privileged user's token among unrelated SANE users. — [OAuth](https://linear.app/developers/oauth-2-0-authentication); [Actor authorization](https://linear.app/developers/oauth-actor-authorization)
- Current OAuth documentation states access tokens last 24 hours and refresh returns both a new access and refresh token. It supports PKCE; PKCE token exchange makes `client_secret` optional, and PKCE refresh can use `client_id`. Use CSRF `state` and validate it. Current docs explicitly say all OAuth apps migrated to refresh tokens on April 1, 2026; do not design around legacy indefinite access tokens. — [OAuth authentication and refresh](https://linear.app/developers/oauth-2-0-authentication)
- Client-credentials tokens are app-actor tokens, initially access all public teams, last 30 days, and have configurable app team access via the app details page. They are not per-human authorization and have no paired refresh token. — [Client credentials](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens)
- Private teams require Business or Enterprise. Their issues normally require team membership; Enterprise issue sharing can grant limited issue access to non-members. Shared-issue users can edit most details/comment but cannot view/change team, project, cycle, or milestone. Documentation explicitly warns that a personal API key from a private-team member can expose private data. — [Private teams and API security](https://linear.app/docs/private-teams)
- Paid workspaces can enable third-party app approvals; installation can be blocked pending admin/owner approval. OAuth availability in an API does not mean a user can always install SANE without workspace approval. — [Application approvals](https://linear.app/docs/third-party-application-approvals)
- `@linear/sdk` package metadata declares MIT and the official repository supplies an MIT license. That license permits reuse/modification/distribution of the library subject to retaining copyright/permission notices. Linear's service is separately proprietary: Terms §1.3 reserves ownership, §2.2 restricts copying/derivative Service work, reverse engineering/non-public APIs, reselling/making the Service available to third parties, and building/supporting competitive services; §2.3 permits enforcement of API limits/suspension. Customer owns User Submissions under §10.2. — [SDK metadata](https://github.com/linear/linear/blob/master/packages/sdk/package.json); [MIT license](https://github.com/linear/linear/blob/master/LICENSE); [Service Terms](https://linear.app/terms)
- Official API documentation expressly supports third-party integrations, querying/mutating customer data, and displaying Linear data in an application. This supports the technical integration pattern, but is not an express exemption from the broad service restrictions for a commercially competing product. — [API and Webhooks](https://linear.app/docs/api-and-webhooks); [Displaying/fetching updates](https://linear.app/developers/graphql#fetching-updates); [Terms](https://linear.app/terms)
- Pricing lists **API and webhook access** and **MCP access** as product features. It lists Free with 2 teams/250 issues and paid plans with higher team/issue allowances; private teams are a paid feature. The consulted pages do not establish a separate per-GraphQL-request or MCP access license fee. Do not turn that into a claim of unrestricted/free service usage or perpetual pricing guarantees. — [Pricing](https://linear.app/pricing); [Private teams](https://linear.app/docs/private-teams); [Terms](https://linear.app/terms)
- The **official, centrally hosted Linear MCP** uses Streamable HTTP at `https://mcp.linear.app/mcp`; OAuth 2.1 with dynamic client registration is its interactive auth flow. `https://mcp.linear.app/mcp/readonly` exposes only read tools, or the normal endpoint can use only OAuth `read`. `/sse` is a deprecated fallback, not the recommended endpoint. Tools find/create/update issues, projects, and comments. — [Official MCP](https://linear.app/docs/mcp)
- MCP also accepts API keys or OAuth tokens through `Authorization: Bearer <token>`; **that MCP key header differs from the direct GraphQL key header**. Each Linear workspace needs a separate MCP authentication context. MCP is a service interface, not an open-source/self-hosted substitute for Linear. The docs describe a centrally managed server and offer no source license for self-hosting its implementation. — [MCP setup and FAQ](https://linear.app/docs/mcp); [GraphQL key header](https://linear.app/developers/graphql#authentication)

### Inferences

- For the human issue panel, per-user OAuth with `read,write` aligns attribution and authorization with the user editing. Store secrets in the appropriate SANE local/secure credential service, never repository-tracked config or a browser-accessible shared credential. A single-user pilot can use a team-restricted Read/Write personal key. These are security/design recommendations informed by the documented token authority. — [API key restrictions](https://linear.app/docs/api-and-webhooks); [OAuth actors](https://linear.app/developers/oauth-2-0-authentication)
- A workspace mapping is a **filter/configuration boundary**, not an authorization mechanism. Partition any caches by connection/organization and authorization context; never expose an admin/private-team key's cached data to another SANE user merely because both opened the same repository. Shared-issue or inaccessible project/cycle details must degrade gracefully. — [Private-team API warnings and shared issue limits](https://linear.app/docs/private-teams)
- Prefer direct GraphQL/SDK for the panel's predictable field selection, pagination, mutations, and errors. Keep official MCP for agents that need Linear tools; do not require an LLM/MCP tool invocation to perform every human UI interaction. — [GraphQL](https://linear.app/developers/graphql); [SDK](https://linear.app/developers/sdk); [MCP](https://linear.app/docs/mcp)
- Treat SANE as an authorized **integration UI for customers' canonical Linear issues**, not a cloned Linear product or subscription escape hatch. Obtain Linear/legal clarification before marketing a replacement/competing issue service or serving unlicensed users through a shared credential. This is risk guidance, not a legal opinion or a finding that a thin integration is prohibited. — [Terms §§1–2](https://linear.app/terms); [Documented third-party integration support](https://linear.app/docs/api-and-webhooks)

### Gaps

- No source reviewed explicitly classifies the exact proposed commercial SANE product under Terms §2.2's competition/resale restrictions. Public API availability alone cannot resolve that legal boundary.
- The pricing page's fetched text loses comparison-table checkmarks; it establishes listed features/limits but should not be cited from this extraction as conclusive cell-by-cell plan entitlement for every API/MCP feature. No separate integration fee was found, but absence is not a contractual promise.
- Exact private-team access granted to a particular OAuth app installation needs verification in that workspace's consent/app settings. User-token access follows the documented actor/user authority; do not infer app-actor installation automatically grants every private team.

## What rate-limit and refresh strategy fits a panel rather than a bulk replica?

### Takeaway

A bounded workspace/team/project panel is feasible without replicating the organization: request explicit small pages and only visible fields, cache option metadata, fetch full descriptions/comments on detail opening, and refresh on user interaction. Webhooks are the official preference for realtime updates, but require public HTTPS/admin setup and are not an automatic localhost capability. — [Rate limits](https://linear.app/developers/rate-limiting); [Fetching updates](https://linear.app/developers/graphql#fetching-updates); [Webhooks](https://linear.app/developers/webhooks)

### Cited Findings

- Documented hourly request limits: personal API key **2,500 per user**, shared across that user's keys; OAuth **5,000 per user or app user**. Complexity limits: API key **3,000,000 points/hour**, OAuth **2,000,000**; **10,000 maximum complexity per query**. Limits use a leaky bucket and can evolve; dynamic increases exist for workspace-level app-actor OAuth based on paid-user count. — [Rate limiting](https://linear.app/developers/rate-limiting)
- Connections default to 50 records. Nested connections multiply complexity. Linear explicitly recommends filtering on the server, specifying page sizes, selecting only needed data, and custom GraphQL queries when SDK calls fetch many entities/dependencies. — [Complexity and SDK advice](https://linear.app/developers/rate-limiting)
- Linear discourages polling, especially polling every issue separately. It recommends webhooks, and if polling is necessary, fetching recently updated records first (`orderBy: updatedAt`) with filters rather than fetching all issues and filtering client-side. — [Fetching updates](https://linear.app/developers/graphql#fetching-updates); [Rate limiting](https://linear.app/developers/rate-limiting)
- Rate responses provide `X-RateLimit-Requests-{Limit,Remaining,Reset}`, complexity equivalents, and endpoint-specific headers where relevant. Resets are UTC epoch milliseconds. GraphQL rate limiting is documented as HTTP 400 with `errors[].extensions.code: RATELIMITED`, **not solely HTTP 429**. Some individual endpoints have lower limits. — [Rate-limit headers and errors](https://linear.app/developers/rate-limiting)
- GraphQL can return HTTP 200 with partial data **and errors**. Check the errors array and mutation `success` rather than treating HTTP status alone as confirmation. — [Error handling](https://linear.app/developers/graphql#error-handling)
- Webhooks are organization-specific and can cover all public teams or one team. OAuth applications can configure automatic organization webhooks on authorization. Creating/reading webhooks through the API requires workspace admin or OAuth `admin` scope. Endpoint must be public HTTPS, non-localhost, return 200, and respond within five seconds; failed deliveries have limited retries, so webhook receipt is not an eternal complete change log. — [Webhooks](https://linear.app/developers/webhooks)
- Webhook verification uses HMAC-SHA256 of the **raw request body** with `Linear-Signature`; timestamp checking protects against replay. Payload contains create/update/remove action, organization context, delivery identity, changed data, and for updates previous changed values. — [Webhook payload/security](https://linear.app/developers/webhooks)

### Inferences

- Start with lazy panel loading, cursor pagination (for example 25 rows), remote team/project filters, and a short-lived read cache plus displayed “last refreshed” time. Fetch one selected issue's description/comments on demand, not every issue's nested comments/labels/history on every list refresh. Refresh after successful writes and on explicit refresh or stale panel focus. These example sizes/timing choices are recommendations, not published Linear quotas. — [Selective queries and complexity](https://linear.app/developers/rate-limiting)
- Cache team states and valid label/user/project options separately from issue contents; key them by organization/team/authorization context and refresh when settings or validation errors indicate staleness. No full organization mirror is necessary for a working panel. — [Team-based models](https://linear.app/developers/graphql); [Schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- If continuous freshness is necessary and webhook hosting is available, use verified events to invalidate/refetch affected cached objects, deduplicate delivery IDs, and reconcile on reconnect. Avoid requesting broad `admin` solely for a first editor: configure webhooks administratively/OAuth app settings, or launch without background realtime and make freshness explicit. — [Webhook configuration/security](https://linear.app/developers/webhooks); [OAuth scope minimization](https://linear.app/developers/oauth-2-0-authentication)
- If webhooks are unavailable, any background polling should be sparse, workspace-scoped, only while useful, and based on filtered recent updates rather than individual issue timers. Handle `RATELIMITED` and reset headers with backoff; preserve a visibly stale read view, but do not show an unconfirmed remote edit as successfully saved. — [Fetching updates](https://linear.app/developers/graphql#fetching-updates); [Rate limits](https://linear.app/developers/rate-limiting)
- Automatic mutation retries need care: do not blindly repeat create/comment mutations after ambiguous network failures, which can duplicate remote objects. Stable client-generated IDs are present in create inputs and may help a deliberately designed recovery flow, but idempotent replay semantics were not verified here. — [Create inputs](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)

### Gaps

- No specific cache TTL or poll interval is mandated by Linear; these must be chosen based on SANE's freshness expectations, active connections, and measured header budgets.
- No panel workload measurements were performed. SDK relationship fetching can create more network requests than a single purpose-built GraphQL query; benchmark only when implementation/testing is explicitly authorized.
- This research does not design a complete synchronization/retention system. Archived resources are excluded by default unless `includeArchived: true`; deletions, permission revocations, membership changes, and disconnected credentials require explicit eviction/reconciliation policies if persistent caching is added. — [Archived resources](https://linear.app/developers/graphql#archived-resources); [Webhook removal/revocation](https://linear.app/developers/webhooks)
