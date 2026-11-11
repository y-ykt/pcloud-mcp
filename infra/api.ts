// © 2026 Yasuhiko Yokote

/**
 * API Gateway (HTTP API).
 *
 * **This uses an HTTP API, not a REST API.**
 * A REST API renames the `WWW-Authenticate` header returned by Lambda to
 * `X-Amzn-Remapped-WWW-Authenticate`, and this cannot be disabled.
 * MCP requires this header on a 401, so a REST API cannot meet the requirement.
 *
 * In exchange, resource policies are not available, so
 * **the source IP check is done inside Lambda** (`ALLOWED_CIDRS`).
 *
 * Because the `$default` stage is used, **the URL contains no stage name.**
 * This lets the RFC 9728 discovery path work unchanged.
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface HttpApiArgs {
  name: string;
}

/**
 * Creates the HTTP API itself.
 *
 * **Create it before Lambda.** The public URL placed in the Lambda environment
 * variables is derived from this API's identifier (there is no cycle).
 */
export function createHttpApi(args: HttpApiArgs): aws.apigatewayv2.Api {
  return new aws.apigatewayv2.Api(`${args.name}-api`, {
    name: args.name,
    description: "pCloud MCP connector",
    protocolType: "HTTP",
    // CORS is not configured, because direct calls from a browser are not expected
  });
}

export interface AttachArgs {
  name: string;
  api: aws.apigatewayv2.Api;
  fn: aws.lambda.Function;
  /** Maximum number of calls per second. */
  throttleRate: number;
  /** Number of calls allowed in a burst. */
  throttleBurst: number;
  /**
   * Destination of the access log.
   *
   * **Keep it separate from the Lambda log group.**
   * The retention periods differ (short for Lambda, long for this one).
   */
  accessLogGroup: aws.cloudwatch.LogGroup;
}

export interface AttachResult {
  stage: aws.apigatewayv2.Stage;
}

/** Integrates Lambda and deploys it to the `$default` stage. */
export function attachLambda(args: AttachArgs): AttachResult {
  const { api, fn } = args;

  const integration = new aws.apigatewayv2.Integration(`${args.name}-int`, {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: fn.invokeArn,
    // Lambda is always invoked with POST
    integrationMethod: "POST",
    // Input format. The format that handler.ts handles
    payloadFormatVersion: "2.0",
    // Lambda stops itself at 25 seconds
    timeoutMilliseconds: 29000,
  });

  // One function receives every method and every path. Lambda does the routing
  new aws.apigatewayv2.Route(`${args.name}-route`, {
    apiId: api.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
  });

  /**
   * The `$default` stage does not put a stage name in the URL.
   * Because it deploys automatically, the Deployment and `triggers` handling that a REST API needs is not required.
   */
  const stage = new aws.apigatewayv2.Stage(`${args.name}-stage`, {
    apiId: api.id,
    name: "$default",
    autoDeploy: true,
    defaultRouteSettings: {
      throttlingRateLimit: args.throttleRate,
      throttlingBurstLimit: args.throttleBurst,
      detailedMetricsEnabled: true,
    },
    /**
     * Access log. **It exists to record requests that never reached Lambda.**
     *
     * For a request that hits the rate limit, API Gateway returns `429` and stops there;
     * **the request never appears in the Lambda logs.** A burst of unauthorized access is rejected here first, so
     * **without this log the events most worth knowing about would not be recorded.**
     *
     * **Headers, bodies, and query strings are not logged.**
     * `Authorization` carries the access token, and the body contains tool arguments
     * (file paths). This log is kept for 5 years, so
     * **only the fields that are safe to include are listed by name.**
     *
     * The only paths of this connector are `/mcp` and `/.well-known/…`, so
     * **no file name appears in `$context.path`.**
     */
    accessLogSettings: {
      destinationArn: args.accessLogGroup.arn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        sourceIp: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        path: "$context.path",
        routeKey: "$context.routeKey",
        status: "$context.status",
        responseLength: "$context.responseLength",
        responseLatency: "$context.responseLatency",
        integrationStatus: "$context.integrationStatus",
        errorMessage: "$context.error.message",
        userAgent: "$context.identity.userAgent",
      }),
    },
  });

  new aws.lambda.Permission(`${args.name}-permission`, {
    action: "lambda:InvokeFunction",
    function: fn.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
  });

  return { stage };
}
