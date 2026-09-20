// Import this FIRST (before express / http are loaded) so they can be auto-instrumented.
// Off by default; set OTEL_ENABLED=true and point OTEL_EXPORTER_OTLP_ENDPOINT at Jaeger / an OTel collector.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { env } from "./config/env";

if (env.OTEL_ENABLED) {
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    // spans for incoming HTTP, express routes, and every Prisma query
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new PrismaInstrumentation()],
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}
