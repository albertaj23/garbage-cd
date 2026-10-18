import { Ajv2020, type AnySchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

export class ContractValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly validators = new Map<string, ValidateFunction>();

  private constructor() {}

  static async load(config: Config): Promise<ContractValidator> {
    const validator = new ContractValidator();
    const schemaDir = join(config.root, "contracts", "schemas");
    const names = [
      "custom-engine-result.schema.json",
      "heap-snapshot.schema.json",
      "region-graph.schema.json",
      "benchmark-summary.schema.json",
      "trace-batch.schema.json",
      "jvm-engine-result.schema.json",
      "run-request.schema.json",
      "run-result.schema.json",
      "static-analysis.schema.json",
      "structured-error.schema.json"
    ];
    const schemas = new Map<string, AnySchemaObject>();
    for (const name of names) {
      const content: unknown = JSON.parse(await readFile(join(schemaDir, name), "utf8"));
      if (
        typeof content !== "object" ||
        content === null ||
        !("$id" in content) ||
        typeof content.$id !== "string"
      ) {
        throw new Error(`Invalid contract schema: ${name}`);
      }
      const schema = content as AnySchemaObject;
      schemas.set(name, schema);
    }
    for (const [name, schema] of schemas) {
      if (name !== "run-request.schema.json") {
        validator.ajv.addSchema(schema);
      }
    }
    for (const [name, schema] of schemas) {
      validator.validators.set(name, validator.ajv.getSchema(String(schema.$id)) ??
        validator.ajv.compile(schema));
    }
    return validator;
  }

  validate(name: string, data: unknown): string[] {
    const validate = this.validators.get(name);
    if (!validate) throw new Error(`Unknown contract schema: ${name}`);
    if (validate(data)) return [];
    return (validate.errors ?? []).map((error) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
    );
  }
}
