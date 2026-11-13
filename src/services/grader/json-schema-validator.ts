/**
 * @fileoverview Compile an embedded JSON Schema in its declared dialect and retain its diagnostics.
 * @module services/grader/json-schema-validator
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

const validators = new Map<string, typeof Ajv | typeof Ajv2019 | typeof Ajv2020>([
  ['http://json-schema.org/draft-07/schema', Ajv],
  ['http://json-schema.org/schema', Ajv],
  ['https://json-schema.org/draft/2019-09/schema', Ajv2019],
  ['https://json-schema.org/draft/2020-12/schema', Ajv2020],
]);
interface CompiledSchema {
  diagnostic: string;
  errorsText: (errors: ValidateFunction['errors']) => string;
  validate: ValidateFunction;
}
const compiledSchemas = new WeakMap<object, { source: string; compiled: CompiledSchema }>();

/** Compile and cache by schema object identity. User schema IDs stay local to each compilation. */
export function compileJsonSchema(schema: Record<string, unknown>): CompiledSchema {
  // Ajv enables async validation for every truthy $async value.
  if (schema.$async) {
    throw validationError(
      'json_match requires a synchronous JSON Schema. Remove $async and any async-only references.',
      { reason: 'grader_unexecutable', field: 'schema' },
    );
  }
  const source = JSON.stringify(schema);
  const cached = compiledSchemas.get(schema);
  if (cached?.source === source) return cached.compiled;

  const dialect = schema.$schema;
  const Validator =
    dialect === undefined
      ? Ajv
      : typeof dialect === 'string'
        ? validators.get(dialect.endsWith('#') ? dialect.slice(0, -1) : dialect)
        : undefined;
  if (!Validator) {
    throw validationError(
      'Unsupported json_match $schema declaration. Use draft-07, 2019-09, or 2020-12.',
      { reason: 'grader_unexecutable', field: 'schema' },
    );
  }

  // Keep Ajv's schema IDs and generated validator scope local to this schema.
  const warnings = new Set<string>();
  try {
    const validator = new Validator({
      allErrors: true,
      strict: false,
      strictSchema: 'log',
      logger: {
        log() {},
        error() {},
        warn(message: string) {
          warnings.add(message);
        },
      },
    });
    const validate = validator.compile(schema);
    const diagnostic = warnings.size
      ? ` Schema warnings: ${[...warnings].join('; ')}.${dialect === undefined ? ' Declare the intended dialect with $schema if it differs from draft-07.' : ''}`
      : '';
    const compiled: CompiledSchema = {
      validate,
      errorsText: (errors) => validator.errorsText(errors),
      diagnostic,
    };
    compiledSchemas.set(schema, { source, compiled });
    return compiled;
  } catch (err) {
    throw validationError(
      'The json_match schema could not compile. Check the declared dialect, keyword values, and local references.',
      { reason: 'grader_unexecutable', field: 'schema' },
      { cause: err },
    );
  }
}
