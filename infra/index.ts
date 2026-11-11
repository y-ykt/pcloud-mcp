// © 2026 Yasuhiko Yokote

/**
 * Assembles the stack.
 *
 * The creation order has reasons.
 *   1. Log groups … created first, so that the execution role's permissions can be limited to them
 *   2. Notification … **created before Lambda**, so that the alarm destination can also be passed to the Lambda alarms
 *   3. Secrets and execution role
 *   4. HTTP API … **created before Lambda.** The public URL is derived from this API's identifier
 *   5. Cognito
 *   6. Lambda … receives the public URL and the Cognito values as environment variables
 *   7. Integration and deployment
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { createAuth } from "./auth";
import { createSecrets } from "./secrets";
import { createLambda } from "./lambda";
import { attachLambda, createHttpApi } from "./api";
import { createNotify } from "./notify";
import { checkGitRoot, checkKnownKeys, gitEnabled, parseForbiddenNames } from "./validate";

const cfg = new pulumi.Config();
// Before anything is read: a misspelled key must not be ignored without a word (see validate.ts)
checkKnownKeys(Object.keys(pulumi.runtime.allConfig()), pulumi.getProject());
const name = `${pulumi.getProject()}-${pulumi.getStack()}`;

const pcloudApiHost = cfg.get("pcloudApiHost") ?? "https://api.pcloud.com";
const allowedCidrs = (cfg.get("claudeEgressCidr") ?? "160.79.104.0/21")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const callbackUrl = cfg.get("callbackUrl") ?? "https://claude.ai/api/mcp/auth_callback";
const logRetentionDays = cfg.getNumber("logRetentionDays") ?? 30;
/**
 * Retention period of the API Gateway access log. **It is set independently of the Lambda side.**
 *
 * The Lambda logs contain file paths, so their retention is short.
 * The access log **contains no file names at all** (see `api.ts`), so
 * it can be kept for a long time to trace unauthorized access. The default is 5 years.
 *
 * CloudWatch accepts only a fixed set of values. 5 years is 1827 days.
 */
const apiLogRetentionDays = cfg.getNumber("apiLogRetentionDays") ?? 1827;
/**
 * Where alarms are delivered.
 *
 * **If it is not set, no notification is delivered.** Only the topic and the alarms are created.
 * The subscription requires a person to click the confirmation link (see `notify.ts`).
 */
const alertEmail = cfg.get("alertEmail");
const throttleRate = cfg.getNumber("throttleRate") ?? 1;
const throttleBurst = cfg.getNumber("throttleBurst") ?? 5;
const downloadMaxBytes = cfg.getNumber("downloadMaxBytes") ?? 1048576;
// Maximum size of a single git pack to fetch. Because of the authentication tag, the whole pack has to be fetched
const gitPackMaxBytes = cfg.getNumber("gitPackMaxBytes") ?? 128 * 1024 * 1024;
// Names of folders that are never entered, separated by commas. Empty: nothing is excluded
const forbiddenNames = cfg.get("forbiddenNames") ?? "";
// Folder on pCloud that holds the encrypted bare repositories read by the git tools.
// **Empty by default: the git tools are disabled**, and nothing is created for them
// (no secret for the key, no permission to read it, no environment variable)
const gitRoot = cfg.get("gitRoot") ?? "";
const withGit = gitEnabled(gitRoot);
// Fail here, at deployment, on a value the server would refuse at startup (see validate.ts)
checkGitRoot(gitRoot, parseForbiddenNames(forbiddenNames));
// Log verbosity. With debug, the tools/call arguments and the breakdown of blocks are also logged
const logLevel = cfg.get("logLevel") ?? "info";
// **For investigation.** When true, file contents are left in CloudWatch. Set it back when done
const logResponseBody = cfg.getBoolean("logResponseBody") ?? false;

/**
 * Time at which the pCloud token was last re-registered.
 *
 * Lambda keeps the token for as long as the execution environment is alive, so
 * **changing this value rewrites the environment variables and recreates the execution environment.**
 * `bin/set-pcloud-token` sets it.
 */
const tokenSetAt = cfg.get("tokenSetAt") ?? "initial";

/**
 * Time at which the git decryption key was last re-registered. The execution environment is recreated for the same reason as for the token.
 * `bin/set-git-encrypt-key` sets it.
 */
const gitKeySetAt = cfg.get("gitKeySetAt") ?? "initial";

const accountId = aws.getCallerIdentityOutput().accountId;

/** Path that receives MCP messages. */
const MCP_PATH = "/mcp";

// ---------------------------------------------------------------- 1. Logs

const logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
  name: `/aws/lambda/${name}`,
  // Do not leave it at the default of never expiring
  retentionInDays: logRetentionDays,
});

/**
 * API Gateway access log. **It records requests that never reached Lambda.**
 *
 * Requests that hit the rate limit (`429`) do not appear in the Lambda logs.
 * **The log group is separate so that the retention period can differ.**
 */
const apiLogGroup = new aws.cloudwatch.LogGroup(`${name}-api-logs`, {
  name: `/aws/apigateway/${name}`,
  retentionInDays: apiLogRetentionDays,
});

// ---------------------------------------------------------------- 2. Notification

const { topic: alertTopic } = createNotify({
  name,
  email: alertEmail,
  accessLogGroup: apiLogGroup,
});

// ---------------------------------------------------------------- 3. Secrets and role

const { secret, gitKeySecret, role } = createSecrets({
  name,
  logGroupArn: logGroup.arn,
  withGitKey: withGit,
});

// ---------------------------------------------------------------- 4. HTTP API

const api = createHttpApi({ name });

/**
 * URL that the user enters into Claude.ai. The PRM `resource` and the token audience are also this value.
 *
 * Because of the `$default` stage, **it contains no stage name.**
 */
const mcpUrl = pulumi.interpolate`${api.apiEndpoint}${MCP_PATH}`;

// ---------------------------------------------------------------- 5. Cognito

const domainPrefix =
  cfg.get("cognitoDomainPrefix") ||
  pulumi.interpolate`${pulumi.getProject()}-${accountId}`;

const auth = createAuth({ name, domainPrefix, callbackUrl });

// ---------------------------------------------------------------- 6. Lambda

const { fn } = createLambda({
  name,
  role,
  logGroup,
  invocationAlarmThreshold: 500,
  alertTopicArn: alertTopic.arn,
  environment: {
    PCLOUD_API_HOST: pcloudApiHost,
    PCLOUD_SECRET_ARN: secret.arn,
    // Present only when the git tools are enabled
    ...(gitKeySecret === undefined
      ? {}
      : { GIT_SECRET_ARN: gitKeySecret.arn, GIT_KEY_SET_AT: gitKeySetAt, GIT_ROOT: gitRoot }),
    RESOURCE_URL: mcpUrl,
    MCP_PATH,
    COGNITO_ISSUER: auth.issuer,
    COGNITO_CLIENT_ID: auth.clientId,
    ALLOWED_CIDRS: allowedCidrs.join(","),
    MCP_SCOPES: auth.scope,
    TOKEN_SET_AT: tokenSetAt,
    DOWNLOAD_MAX_BYTES: String(downloadMaxBytes),
    // Left out when empty, so that the variable is absent rather than set to an empty value
    ...(forbiddenNames.trim() === "" ? {} : { FORBIDDEN_NAMES: forbiddenNames }),
    GIT_PACK_MAX_BYTES: String(gitPackMaxBytes),
    LOG_LEVEL: logLevel,
    LOG_RESPONSE_BODY: String(logResponseBody),
  },
});

// ---------------------------------------------------------------- 7. Integration and deployment

attachLambda({ name, api, fn, throttleRate, throttleBurst, accessLogGroup: apiLogGroup });

// ---------------------------------------------------------------- Outputs

/** URL to register in Claude.ai. */
export const connectorUrl = mcpUrl;
/** Client identifier to enter into Claude by hand. */
export const clientId = auth.clientId;
/** For verification. */
export const authorizeUrl = auth.authorizeUrl;
export const tokenUrl = auth.tokenUrl;
export const scope = auth.scope;
/** Location of the PRM document. Authorization starts from it. */
export const prmUrl = pulumi.interpolate`${api.apiEndpoint}/.well-known/oauth-protected-resource${MCP_PATH}`;
/** Where to register the pCloud token (Pulumi does not hold the value). */
export const pcloudSecretName = secret.name;
/** Where to register the git decryption key (Pulumi does not hold the value). */
export const gitKeySecretName = gitKeySecret?.name;
/** Used when creating the user. */
export const userPoolId = auth.userPool.id;
export const logGroupName = logGroup.name;
export const apiLogGroupName = apiLogGroup.name;
/** Alarm destination. No notification is delivered while the subscription is unconfirmed. */
export const alertTopicArn = alertTopic.arn;
