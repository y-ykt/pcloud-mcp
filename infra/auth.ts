// © 2026 Yasuhiko Yokote

/**
 * Cognito User Pool and app client.
 *
 * There is one user. Self sign-up is disabled.
 * **The user itself is not created with Pulumi**, because the initial password would remain
 * in the state file. Create the user with the AWS CLI.
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/** Identifier of the resource server. The scope becomes `pcloud/read`. */
const RESOURCE_SERVER_ID = "pcloud";
const READ_SCOPE = "read";

export interface AuthArgs {
  /** Prefix for resource names. */
  name: string;
  /** Domain prefix of the hosted UI. It must be globally unique. */
  domainPrefix: pulumi.Input<string>;
  /** Callback URL, registered as an exact match. */
  callbackUrl: pulumi.Input<string>;
}

export interface AuthResult {
  userPool: aws.cognito.UserPool;
  client: aws.cognito.UserPoolClient;
  /** The `iss` of the tokens and the source of the JWKS. */
  issuer: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
  /** Where authorization starts, and where the token is exchanged. */
  authorizeUrl: pulumi.Output<string>;
  tokenUrl: pulumi.Output<string>;
  /** Scope that the app client can request. */
  scope: string;
}

export function createAuth(args: AuthArgs): AuthResult {
  const userPool = new aws.cognito.UserPool(`${args.name}-pool`, {
    name: `${args.name}-pool`,
    // The administrator creates the user. Do not let anyone register
    adminCreateUserConfig: { allowAdminCreateUserOnly: true },
    passwordPolicy: {
      minimumLength: 12,
      requireLowercase: true,
      requireUppercase: true,
      requireNumbers: true,
      requireSymbols: true,
    },
    // Prevent responses from revealing whether a user exists
    usernameConfiguration: { caseSensitive: false },
    autoVerifiedAttributes: ["email"],
    schemas: [
      { name: "email", attributeDataType: "String", required: true, mutable: true },
    ],
  });

  const domain = new aws.cognito.UserPoolDomain(`${args.name}-domain`, {
    domain: args.domainPrefix,
    userPoolId: userPool.id,
  });

  /**
   * Registers a resource server and defines a custom scope.
   * Without it, no access token is issued and only an ID token is obtained.
   */
  const resourceServer = new aws.cognito.ResourceServer(`${args.name}-rs`, {
    identifier: RESOURCE_SERVER_ID,
    name: `${args.name} resource server`,
    userPoolId: userPool.id,
    scopes: [{ scopeName: READ_SCOPE, scopeDescription: "Read access to pCloud" }],
  });

  const scope = `${RESOURCE_SERVER_ID}/${READ_SCOPE}`;

  /**
   * Allows the standard scopes in addition to the custom scope.
   *
   * This is **so that a client requesting `openid` is not rejected with `invalid_scope`**
   * (confirmed by testing). Without it, authorization does not start.
   * This server does not separate permissions by scope (there is one user).
   */
  const allowedScopes = [scope, "openid", "email", "profile"];

  const client = new aws.cognito.UserPoolClient(
    `${args.name}-client`,
    {
      name: `${args.name}-client`,
      userPoolId: userPool.id,
      // Public client. It has no secret (only the client_id is entered into Claude)
      generateSecret: false,
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ["code"],
      allowedOauthScopes: allowedScopes,
      callbackUrls: [args.callbackUrl],
      supportedIdentityProviders: ["COGNITO"],
      // Prevent responses from revealing whether a user name exists
      preventUserExistenceErrors: "ENABLED",
      enableTokenRevocation: true,
      explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      accessTokenValidity: 1,
      idTokenValidity: 1,
      refreshTokenValidity: 30,
      tokenValidityUnits: { accessToken: "hours", idToken: "hours", refreshToken: "days" },
    },
    { dependsOn: [resourceServer] },
  );

  const region = aws.getRegionOutput().name;
  const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`;
  const base = pulumi.interpolate`https://${domain.domain}.auth.${region}.amazoncognito.com`;

  return {
    userPool,
    client,
    issuer,
    clientId: client.id,
    authorizeUrl: pulumi.interpolate`${base}/oauth2/authorize`,
    tokenUrl: pulumi.interpolate`${base}/oauth2/token`,
    scope,
  };
}
