// © 2026 Yasuhiko Yokote

/**
 * Secrets Manager and the Lambda execution role.
 *
 * **Pulumi defines only that the secrets exist and never handles their values.**
 * The user registers the values with the AWS CLI.
 * This keeps the pCloud token out of the state file.
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface SecretsArgs {
  name: string;
  /** Log group that the role is allowed to write to. */
  logGroupArn: pulumi.Input<string>;
  /**
   * Whether the git tools are enabled. **When false, neither the secret for the key
   * nor the permission to read it is created.**
   */
  withGitKey: boolean;
}

export interface SecretsResult {
  secret: aws.secretsmanager.Secret;
  /** Undefined when the git tools are disabled. */
  gitKeySecret: aws.secretsmanager.Secret | undefined;
  role: aws.iam.Role;
}

export function createSecrets(args: SecretsArgs): SecretsResult {
  // The value (SecretVersion) is not defined
  const secret = new aws.secretsmanager.Secret(`${args.name}-pcloud-token`, {
    name: `${args.name}/pcloud-token`,
    description: "pCloud access token (set manually; Pulumi never holds the value)",
    recoveryWindowInDays: 7,
  });

  /**
   * Decryption key for the git repositories (the folder named by `gitRoot`). It is handled the same way as the token:
   * only the secret itself is defined, and the user registers the value with `bin/set-git-encrypt-key`.
   * **Created only when the git tools are enabled.**
   */
  const gitKeySecret = args.withGitKey
    ? new aws.secretsmanager.Secret(`${args.name}-git-encrypt-key`, {
        name: `${args.name}/git-encrypt-key`,
        description:
          "AES-256-GCM key of the encrypted git repositories (set manually; Pulumi never holds the value)",
        recoveryWindowInDays: 7,
      })
    : undefined;

  const role = new aws.iam.Role(`${args.name}-lambda-role`, {
    name: `${args.name}-lambda-role`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });

  /**
   * Only two permissions are granted.
   *   - Reading **the secrets of this stack**: the pCloud token, and the git decryption key
   *     when the git tools are enabled
   *   - Writing to its own log group
   *
   * The managed policy (`AWSLambdaBasicExecutionRole`) is not used.
   * It also allows creating log groups, which is unnecessary here because Pulumi creates the log group.
   */
  new aws.iam.RolePolicy(`${args.name}-lambda-policy`, {
    role: role.id,
    policy: pulumi
      // An empty string stands for "no git key"; it is dropped below
      .all([secret.arn, gitKeySecret?.arn ?? "", args.logGroupArn])
      .apply(([secretArn, gitKeyArn, logArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ReadOwnSecretsOnly",
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: gitKeyArn === "" ? [secretArn] : [secretArn, gitKeyArn],
            },
            {
              Sid: "WriteOwnLogs",
              Effect: "Allow",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: `${logArn}:*`,
            },
          ],
        }),
      ),
  });

  return { secret, gitKeySecret, role };
}
