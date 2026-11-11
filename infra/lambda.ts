// © 2026 Yasuhiko Yokote

/**
 * Lambda function, log group, and alarms.
 *
 * Only the contents of `server/dist` are deployed.
 * `npm run build` copies the runtime dependencies (`mupdf`, `mammoth`, `fflate`, `turndown`
 * and what they depend on) into `dist/node_modules/`.
 */
import * as path from "node:path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/** Build output directory. Created by `npm run build`. */
const DIST = path.resolve(__dirname, "..", "server", "dist");

export interface LambdaArgs {
  name: string;
  role: aws.iam.Role;
  logGroup: aws.cloudwatch.LogGroup;
  /** Environment variables passed to the function. **The pCloud token is not included** (only the ARN is passed). */
  environment: pulumi.Input<Record<string, pulumi.Input<string>>>;
  /** Threshold for the invocation count alarm (per 5 minutes). */
  invocationAlarmThreshold: number;
  /**
   * Alarm destination (the topic that `notify.ts` creates).
   *
   * **Without it, an alarm only changes state and reaches no one.**
   */
  alertTopicArn: pulumi.Input<string>;
}

export interface LambdaResult {
  fn: aws.lambda.Function;
}

export function createLambda(args: LambdaArgs): LambdaResult {
  const fn = new aws.lambda.Function(`${args.name}-fn`, {
    name: `${args.name}`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    handler: "handler.handler",
    role: args.role.arn,
    code: new pulumi.asset.FileArchive(DIST),
    // Stops itself before the 29-second limit of API Gateway
    timeout: 25,
    // PDF rendering (mupdf) uses the most memory. CPU allocation is also proportional to memory,
    // so this also shortens rendering time
    memorySize: 1024,
    environment: { variables: args.environment },
    loggingConfig: {
      logFormat: "JSON",
      logGroup: args.logGroup.name,
      applicationLogLevel: "INFO",
      systemLogLevel: "WARN",
    },
  });

  const dims = { FunctionName: fn.name };

  // Alarm for noticing that failures are continuing
  new aws.cloudwatch.MetricAlarm(`${args.name}-errors`, {
    name: `${args.name}-errors`,
    namespace: "AWS/Lambda",
    metricName: "Errors",
    dimensions: dims,
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 5,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [args.alertTopicArn],
    alarmDescription: "More than 5 failures in 5 minutes",
  });

  // Alarm for noticing invocations far above the expected count
  new aws.cloudwatch.MetricAlarm(`${args.name}-invocations`, {
    name: `${args.name}-invocations`,
    namespace: "AWS/Lambda",
    metricName: "Invocations",
    dimensions: dims,
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: args.invocationAlarmThreshold,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [args.alertTopicArn],
    alarmDescription: "The invocation count is far above the expected count",
  });

  return { fn };
}
