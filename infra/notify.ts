// © 2026 Yasuhiko Yokote

/**
 * Notifies about connections from sources that are not allowed.
 *
 * **What is monitored is the API Gateway access log**, not the Lambda logs.
 * There are two reasons.
 *
 *   1. **The source check is the only place in the whole handler that returns `403`**, so
 *      a `403` in the access log corresponds one-to-one to a connection from a source that is not allowed
 *   2. The access log is kept for 5 years. **When an investigation starts after a notification arrives,
 *      this is the log that still holds the evidence** (the Lambda side has a short retention period)
 *
 * **The notification body does not contain the source IP**, because an alarm can only carry a count.
 * Instead, the alarm description states which log group to filter, and with what pattern, to find the source.
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/** Namespace for the custom metric. The name must not collide with the AWS namespaces. */
const NAMESPACE = "pcloud-mcp";

/** Number of connections from sources that are not allowed. */
const METRIC_NAME = "SourceRejected";

/** Condition for matching access log entries. `$.status` is recorded as a string. */
const PATTERN = '{ $.status = "403" }';

export interface NotifyArgs {
  name: string;
  /**
   * Email address to notify.
   *
   * **If it is not set, only the topic is created, not the subscription.**
   * This lets the alarms be set up before the destination is decided.
   */
  email?: string;
  /** Access log to monitor. */
  accessLogGroup: aws.cloudwatch.LogGroup;
}

export interface NotifyResult {
  /** Alarm destination. The existing alarms also send to it. */
  topic: aws.sns.Topic;
}

export function createNotify(args: NotifyArgs): NotifyResult {
  const { name } = args;

  const topic = new aws.sns.Topic(`${name}-alerts`, {
    name: `${name}-alerts`,
    displayName: "pCloud MCP",
  });

  /**
   * Allows CloudWatch to publish alarms.
   *
   * The default policy already allows publishing from the same account, but
   * **this states explicitly who may publish and for what purpose.**
   * `SourceOwner` is set so that publishing from other accounts is not allowed.
   */
  new aws.sns.TopicPolicy(`${name}-alerts-policy`, {
    arn: topic.arn,
    policy: pulumi
      .all([topic.arn, aws.getCallerIdentityOutput().accountId])
      .apply(([arn, account]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowCloudWatchAlarms",
              Effect: "Allow",
              Principal: { Service: "cloudwatch.amazonaws.com" },
              Action: "SNS:Publish",
              Resource: arn,
              Condition: { StringEquals: { "AWS:SourceOwner": account } },
            },
          ],
        }),
      ),
  });

  /**
   * Email subscription.
   *
   * **It does not become active until a person clicks the confirmation link.**
   * Pulumi cannot do this, so the subscription stays unconfirmed right after creation.
   */
  if (args.email !== undefined && args.email.length > 0) {
    new aws.sns.TopicSubscription(`${name}-alerts-email`, {
      topic: topic.arn,
      protocol: "email",
      endpoint: args.email,
    });
  }

  new aws.cloudwatch.LogMetricFilter(`${name}-rejected-filter`, {
    name: `${name}-source-rejected`,
    logGroupName: args.accessLogGroup.name,
    pattern: PATTERN,
    metricTransformation: {
      name: METRIC_NAME,
      namespace: NAMESPACE,
      value: "1",
      unit: "Count",
    },
  });

  /**
   * Notifies if there is even one occurrence within 5 minutes.
   *
   * **An alarm fires only when its state changes.**
   * A sustained attack does not produce hundreds of emails; once it stops and the alarm returns to `OK`, the next burst produces a notification again.
   *
   * While there are no matches, the metric emits no data. `notBreaching` returns the alarm to `OK`.
   */
  new aws.cloudwatch.MetricAlarm(`${name}-source-rejected`, {
    name: `${name}-source-rejected`,
    namespace: NAMESPACE,
    metricName: METRIC_NAME,
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 0,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [topic.arn],
    alarmDescription: pulumi.interpolate`A connection came from a source that is not allowed. The notification does not contain the source IP. Filter the log group ${args.accessLogGroup.name} with ${PATTERN} to find the sourceIp.`,
  });

  return { topic };
}
