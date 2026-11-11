<!-- © 2026 Yasuhiko Yokote -->
# pCloud MCP connector

**A remote MCP server that lets Claude.ai and the Claude mobile app read the files in a pCloud account.**
It runs on AWS (Lambda, API Gateway HTTP API, Cognito) and is deployed with Pulumi. The code is TypeScript.

**This is an unofficial project. It is not affiliated with, endorsed by or supported by pCloud.**
"pCloud" is used here only to name the service the server connects to.

MCP (Model Context Protocol) is the protocol through which a model is given tools.
PRM (Protected Resource Metadata) is the document in which a protected resource says where its authorization server is.

## What it can and cannot do

| | |
|---|---|
| Can | List folders, get metadata, **read content** (text, images, Word / Excel / PowerPoint, PDF). When enabled, also **read encrypted bare git repositories** stored in one folder (both loose objects and packs) |
| **Cannot** | **Write anything** (upload, delete, overwrite, change sharing), read the **Crypto Folder**, search |

**The server is read-only.** No code path calls a pCloud method that writes.
The Crypto Folder is out of reach: the public pCloud API has no method for it.

**Folders can be closed off by name.** Every name listed in the setting `forbiddenNames` is refused wherever it appears in a path, is left out of listings, and is masked in the log.
The match is on the whole name of a folder or file and ignores case: listing `private` closes `/private` and `/a/Private/b`, but not `/private.txt`.
**The list is empty by default, so nothing is closed off.**
The names are separated by commas, so a name that itself contains a comma cannot be listed.

pCloud returns no path for a file or folder asked for by its ID (`file_id`, `folder_id`).
The server therefore asks pCloud about the folders above it, one by one, and puts the path together from their names.
That path is given in the answer, and it is held to the same list of names: an ID does not get around a closed-off folder.
What is learned about a folder is remembered for up to 5 minutes. A folder moved into a closed-off folder can stay reachable by ID for that long, and a folder that was renamed can be shown under its old path for that long.
For the git tools the list applies to the folder and the name of the repository, not to what is inside it: a branch or a file in a repository may have any name.

Images are returned as JPEG, PNG, GIF or WebP.
A JPEG, PNG or GIF that is too large is downscaled until it fits in a tool result.
**A WebP cannot be downscaled here, so it is returned only when the file is 64 KiB or smaller and its long edge is 2,576 px or less.**

## The tools

There are three tools. Three more, for git repositories, exist only when they are enabled.

| Tool | Purpose |
|---|---|
| `list` | List a folder |
| `stat` | Metadata of one file or folder |
| **`read_file`** | **Read content. The server decides the format** |

**Formats that cannot be handled (legacy Office formats, archives, audio and so on) are refused before anything is downloaded.**

**The server fetches a file itself and returns its content inside the tool result.**
It does not return a link for Claude to follow. When this design was made, that was tried and measured:
Claude did not fetch a URL that a tool returned as a `resource_link`, and neither `web_fetch` nor the code execution environment could reach it.
This is also why there are limits on size: a tool result can carry only so much.

### The git tools (off by default)

| Tool | Purpose |
|---|---|
| `git_ls` | List the files of a bare repository at a commit |
| `git_read` | Read a file of a bare repository at a commit. **Handles the same formats as `read_file`** |
| `git_log` | History of a bare repository |

These read bare git repositories that are kept on pCloud in encrypted form.
**They are off unless the setting `gitRoot` names the folder that holds the repositories.**
While they are off, the tools are not listed, nothing is read for them, and nothing is created for them on AWS
(no secret for the key, and no permission to read one).

**This repository reads such repositories; it contains nothing that writes them.**
The tools are useful only if you already keep repositories in the form they expect:
every file of the bare repository **encrypted with AES-256-GCM** as a 12-byte nonce, the ciphertext, then a 16-byte authentication tag.
`read_file` cannot read such files; only the git tools decrypt them.

To turn the git tools on:

1. Set `gitRoot` in the configuration file, for example `pcloud-mcp:gitRoot: /git-repository`, together with `gitKeyFile` and `gitVerifyRepo`.
2. Run `pulumi up`. This creates the secret for the key.
3. Run `bin/set-git-encrypt-key` (see "Register the git key" below). **Until the key is registered the git tools fail.**
4. Reconnect the connector in Claude.ai, because the list of tools has changed.

To turn them off again, remove `gitRoot` and run `pulumi up`.
**The secret is then deleted with a 7-day recovery window.** Turning the tools on again within those 7 days fails,
because a secret of the same name cannot be created; restore the secret first, or wait.

## Connect

In the Claude.ai settings, add a custom connector and enter:

| Field | Value |
|---|---|
| URL | The value of `pulumi stack output connectorUrl` |
| Client ID | The value of `pulumi stack output clientId` |

**The URL must match `RESOURCE_URL` exactly.** It is compared with `resource` in the PRM document.

**Reconnect after changing a tool definition (name, description or arguments).**
The tool list is fetched only at connection time. A change to the implementation alone needs no reconnection.

## Requirements

| Tool | Used for |
|---|---|
| Node.js 24 or later | Building and testing `server`; running Pulumi |
| Pulumi CLI | Deploying `infra` |
| AWS CLI, with credentials for the target account | The scripts in `bin/`; creating the Cognito user |
| `python3`, `curl` | The scripts in `bin/` |
| Go | Only when `bin/set-pcloud-token` issues a token itself (see "Replace the pCloud token") |

## Configure

**All settings live in one file: `infra/Pulumi.<stack>.yaml`.** It is not tracked.
Create it from the example:

```bash
cp infra/Pulumi.prod.yaml.example infra/Pulumi.prod.yaml
```

Pulumi reads the deployment settings from it. The scripts in `bin/` read the local paths from the same file.
For the local paths, an environment variable, when set, wins over the file.
The region is the exception: the scripts use `aws:region` from the file, and fall back to `AWS_REGION` only when the file does not set it.
That keeps the secrets in the region that `pulumi up` deploys to.

**A key that the project does not know stops the deployment.**
Pulumi ignores an unknown key without a word, so a misspelled one, such as `forbiddenName` for `forbiddenNames`, would simply not apply.
`pulumi up` fails instead and names the key.

### Deployment settings

| Key | Default | Description |
|---|---|---|
| `aws:region` | — | The AWS region to deploy to |
| `pcloudApiHost` | `https://api.pcloud.com` | European accounts use `https://eapi.pcloud.com` |
| `claudeEgressCidr` | `160.79.104.0/21` | Source addresses allowed to call the server. Separate several ranges with commas |
| `callbackUrl` | `https://claude.ai/api/mcp/auth_callback` | Callback URL registered in Cognito |
| `forbiddenNames` | none | Names of folders that are never entered, separated by commas, for example `private,Crypto Folder`. Empty means nothing is excluded |
| `gitRoot` | none | Folder that holds the encrypted bare repositories. **Empty means the git tools are off** |
| `downloadMaxBytes` | `1048576` | Largest non-text file `read_file` fetches |
| `gitPackMaxBytes` | `134217728` | Largest git pack fetched. Used only when the git tools are on |
| `logRetentionDays` | `30` | Retention of the server log |
| `apiLogRetentionDays` | `1827` | Retention of the access log |
| `throttleRate` / `throttleBurst` | `1` / `5` | Request rate limit |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `logResponseBody` | `false` | **For investigation only.** See "Logs" |
| `alertEmail` | none | Where alarms are sent. **Without it no notification is delivered** |
| `cognitoDomainPrefix` | project name and AWS account ID | Domain prefix of the Cognito hosted UI. It must be unique within the region |

`tokenSetAt` and `gitKeySetAt` also appear in the file. The scripts in `bin/` write them; do not edit them by hand.

### Local paths, used by the scripts in `bin/`

| Key | Environment variable | Description |
|---|---|---|
| `pcloudTokenFile` | `PCLOUD_TOKEN_FILE` | File holding the pCloud access token. Default `~/.pcloud-access-token` |
| `oauthToolDir` | `PCLOUD_OAUTH_TOOL_DIR` | Directory of the tool that issues a token (see below) |
| `gitKeyFile` | `GIT_ENCRYPT_KEY_FILE` | File holding the AES-256-GCM key: 64 hexadecimal characters. Needed only when the git tools are on |
| `gitVerifyRepo` | `GIT_VERIFY_PATH` (the whole path of a `HEAD` file) | A repository under `gitRoot`. Its `HEAD` is decrypted to verify the key. Needed only when the git tools are on |

`PULUMI_STACK` selects a stack other than `prod`.

### Lambda environment variables

Pulumi sets these. `server/src/config.ts` reads them at startup and **fails at once if a required one is missing.**

| Variable | Description |
|---|---|
| `PCLOUD_API_HOST` | pCloud API endpoint |
| `PCLOUD_SECRET_ARN` | ARN of the secret in Secrets Manager. **The token itself is never placed here** |
| `COGNITO_ISSUER` / `COGNITO_CLIENT_ID` | Used to verify access tokens |
| `RESOURCE_URL` | Published as `resource` in the PRM document. **Must match the connector URL exactly** |
| `MCP_PATH` | Path that receives MCP messages. Default `/mcp` |
| `ALLOWED_CIDRS` | Source addresses allowed to call |
| `MCP_SCOPES` | Scopes published in the PRM document. Default `pcloud/read` |
| `LIST_MAX_ENTRIES` | Default limit of a listing (200) |
| `LIST_MAX_DEPTH` | Default depth of a recursive listing (2) |
| `READ_MAX_BYTES` | Largest text returned (256 KiB) |
| `DOWNLOAD_MAX_BYTES` | Largest non-text file `read_file` fetches (1 MiB). Also limits a single file read by the git tools |
| `FORBIDDEN_NAMES` | Names of folders that are never entered, separated by commas. Absent or empty: nothing is excluded |
| `GIT_ROOT` | Folder that holds the encrypted bare repositories. **Absent when the git tools are off**, and so are the next two |
| `GIT_SECRET_ARN` | ARN of the git key in Secrets Manager |
| `TOKEN_SET_AT` | When the token was last registered. `bin/set-pcloud-token` updates it. The server does not read it; changing it makes Lambda start a new execution environment |
| `GIT_KEY_SET_AT` | The same for the git key. `bin/set-git-encrypt-key` updates it |
| `GIT_PACK_MAX_BYTES` | Largest git pack fetched (128 MiB). A pack must be fetched whole because of the authentication tag |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Default `info` |
| `AWS_REGION` | Set by Lambda itself, not by Pulumi. The region of Secrets Manager |
| `LOG_RESPONSE_BODY` | **For investigation only.** When true, returned content is written to the log. Default false |

## Deploy

```bash
# 1. Create the configuration file and the stack (first time only)
cd infra
cp Pulumi.prod.yaml.example Pulumi.prod.yaml   # then edit it
pulumi stack init prod

# 2. Build the Lambda and deploy
#    Run "npm run build" after every change under server/. Pulumi does not see source changes
cd ../server && npm ci && npm run build && cd ../infra
npm ci
pulumi up --yes

# 3. Register the pCloud token
../bin/set-pcloud-token

# 3'. Register the git key (only when the git tools are on, that is, gitRoot is set)
../bin/set-git-encrypt-key

# 4. Create a Cognito user
aws cognito-idp admin-create-user --user-pool-id "$(pulumi stack output userPoolId)" …

# 5. Print the values needed to connect
pulumi stack output connectorUrl clientId
```

**Steps 3, 3' and 4 handle a token, a key and an initial password. Run them yourself; do not hand them to an AI assistant.**

Pulumi never holds the token or the key. It creates empty secrets, and the scripts fill them.

If `pulumi config set` refuses a value because it "looks like a secret", add `--plaintext`.

### Replace the pCloud token

Use `bin/set-pcloud-token`. **Do not run `put-secret-value` by hand.**
Wrapping the value in JSON twice is an easy mistake, and it shows up as `Invalid 'access_token' (2094)`.
Before registering, the script checks that pCloud accepts the token. After registering, it reads the value back and compares.

**Registering alone does not take effect.** A running Lambda environment keeps the token it loaded,
so the script goes on to run `pulumi up` and replace the environment.

Before that it runs a preview. **If the deployment would delete or replace a resource, the script stops and deploys nothing**:
registering a token changes only the Lambda function, so anything more means the configuration file says something else as well, and that is for you to decide.
If the preview or `pulumi up` fails, the script shows the output and ends with an error; the token is registered by then, but the running Lambda keeps the old one until `pulumi up` succeeds.
`bin/set-git-encrypt-key` deploys in the same way.

The script obtains a new token by running `go run ./cmd/oauth2-acquire` in the directory named by `oauthToolDir`.
That tool belongs to a separate project and is not part of this repository.
Any other way of obtaining a pCloud OAuth access token works as well:
write the token to the file named by `pcloudTokenFile` and run `bin/set-pcloud-token --reuse`.

### Register the git key

This applies only when the git tools are on. With `gitRoot` not set, the script says so and stops: there is no key to register.

Use `bin/set-git-encrypt-key`. **Do not run `put-secret-value` by hand.**
The key is read from the file named by `gitKeyFile`.

Before registering, the script **downloads the `HEAD` of the repository named by `gitVerifyRepo` and checks that the key decrypts it**
(the AES-256-GCM authentication tag must verify). After registering, it reads the value back and compares.
The key is never shown on the screen, in the shell history or in command arguments.
As with the token, the script also replaces the Lambda environment.

## Logs

**File content and the URLs returned by `getfilelink` are never logged.**
Anyone who knows such a URL can fetch the content.
The names listed in `forbiddenNames` are masked as well: with `private` listed, `/private/x` is logged as `/***/x`.

```bash
aws logs tail /aws/lambda/pcloud-mcp-prod     --since 1h --format short   # server log
aws logs tail /aws/apigateway/pcloud-mcp-prod --since 1h --format short   # access log
```

### There are two log groups

| Log group | Content | Default retention |
|---|---|---|
| `/aws/lambda/pcloud-mcp-prod` | The server log. **Contains file paths** (masked as above) | 30 days |
| `/aws/apigateway/pcloud-mcp-prod` | **The access log**: `requestId`, source address, status code, route, user agent | 5 years |

**The access log contains no file names.**
The only paths of this connector are `/mcp` and `/.well-known/…`, and tool arguments travel in the request body.
**Headers, bodies and query strings are not logged**, because `Authorization` carries a token.
That is why this log can be kept for a long time.

**A request that never reached the Lambda appears only in the access log.**
A request that hits the rate limit (`429`) is answered by API Gateway.

**The access log is delivered with a delay** (about 40 seconds when measured). An empty result is not yet a failure.

### Retention changed by hand

If you shorten the retention of a log group in the AWS console, Pulumi does not notice:
it does not re-read existing resources by default and reports "no changes".
**`pulumi refresh` then restores the declared value.** Do not run it unless you intend that.

### `LOG_RESPONSE_BODY`

When `logResponseBody` is true, **file content stays in the log for the whole retention period.**
Use it only for an investigation and **turn it off afterwards.**
It is separate from `logLevel` so that raising the level alone never leaks content.

## Alarms

**An email is sent when a connection arrives from a source address that is not allowed.**

Set `alertEmail` in the configuration file and run `pulumi up`.
The subscription must be confirmed through the link in the email AWS sends.

There are three alarms. All of them notify the same topic (`pcloud-mcp-prod-alerts`).

| Alarm | Fires when |
|---|---|
| `pcloud-mcp-prod-source-rejected` | **One or more requests from a disallowed source in 5 minutes** |
| `pcloud-mcp-prod-errors` | More than 5 failures in 5 minutes |
| `pcloud-mcp-prod-invocations` | More than 500 invocations in 5 minutes |

**An alarm notifies only when its state changes.**
A burst of connections produces one email. Once the alarm returns to `OK`, the next burst notifies again.
**No notification is sent on recovery.**

### The email does not contain the source address

An alarm carries only a count. **Look up the source in the access log.**

```bash
aws logs filter-log-events --log-group-name /aws/apigateway/pcloud-mcp-prod \
  --filter-pattern '{ $.status = "403" }' --since 1h
```

The same filter is written in the alarm description, so **the email alone is enough to start.**

The server returns `403` in exactly one place: the source address check.
**A `403` in the access log therefore always means a connection from a disallowed source.**

### Measured delay

From the request to the arrival of the email took **about a minute and a half** (measured 2026-07-28).

## Develop

```bash
cd server
npm test            # unit tests
npm run typecheck   # type check
npm run build       # builds dist/ and bundles the runtime dependencies
```

**Run any experiment that imports `mupdf` from inside `server/`.**
Module resolution starts from the importing file, so it fails elsewhere.

`sbom/` holds the software bill of materials and the vulnerability report of the npm dependencies.

## Remove

```bash
cd infra && pulumi destroy
```

**Nothing on pCloud is affected.** Every resource of this stack can be created again.

| Resource | Note |
|---|---|
| Secrets Manager | **Deleted after a 7-day recovery window.** To create a secret of the same name sooner, restore it or wait |
| CloudWatch Logs | Follows the retention setting |
| Cognito User Pool | Deleted together with its users |

## Contributions

**This repository is read-only.** It is published as a reference, and it is not developed here in the open:
issues and pull requests are not accepted, and none will be answered.
You are free to fork it under the terms of the license below.

## How this was built

**The implementation is joint work between a human and Claude, Anthropic's AI model.**
The human set the goals, made the design decisions, approved every step and carried out every operation that touches a secret.
Claude wrote the code, the tests and the documents.

The work followed the **Precious Vibe Coding (PVC) protocol**, a plan-first way of working with an AI model:

1. **Plan first.** Before any code or document is written, Claude presents the structure: files, responsibilities, section headings. Nothing is implemented until the human approves the plan.
2. **One unit at a time.** The work proceeds in small units, such as one module, one function or one section.
3. **Checkpoint after every unit.** Claude stops and reports. The next unit starts only after the human confirms.
4. **Changes as diffs.** A requested change is made as a local edit with its reason, never by regenerating a whole file.

## License

The code in this repository is released under the MIT License. See [`LICENSE`](LICENSE).

### The deployed server is subject to the AGPL

**The server depends on MuPDF, which is licensed under the GNU Affero General Public License (AGPL-3.0-or-later).**
MuPDF renders PDF pages, extracts their text and downscales images.

The MIT License above covers only the code in this repository. It does not change the license of MuPDF.
A server built from this repository contains MuPDF, so **the AGPL applies to the deployed server as a whole.**
In particular, if you let other people use a server you run, the AGPL requires you to offer them the complete source of that server, including your own changes.
If you cannot meet the requirements of the AGPL, the publisher of MuPDF, Artifex, offers a commercial license.

This is a description, not legal advice. Read the license of MuPDF before you deploy.

### Licenses of the dependencies

No dependency is distributed with this repository; `npm ci` downloads them.

| Package | License | Part of the deployed server |
|---|---|---|
| `mupdf` | **AGPL-3.0-or-later** | Yes |
| `mammoth` | BSD-2-Clause | Yes |
| `fflate` | MIT | Yes |
| `turndown` | MIT | Yes |
| `turndown-plugin-gfm` | MIT | Yes |
| `@pulumi/pulumi` | Apache-2.0 | No (deployment only) |
| `@pulumi/aws` | Apache-2.0 | No (deployment only) |
| `typescript` | Apache-2.0 | No (build only) |
| `@types/node` | MIT | No (build only) |

The packages these depend on use MIT, ISC, BSD, Apache-2.0 or similar licenses.
`jszip` is offered under MIT or GPL-3.0-or-later; it is used under MIT.
The complete list is in the SBOM files under `sbom/`.

---

© 2026 Yasuhiko Yokote
