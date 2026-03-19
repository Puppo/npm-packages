import type { ModelContextTesting, ToolListItem } from '@mcp-b/webmcp-types';
import type { JSONSchema7 } from 'json-schema';
import type {
  JsonSchemaExecutableToolDescriptor,
  JsonSchemaExecutableToolDescriptors,
  JsonSchemaToolDescriptor,
  JsonSchemaToolDescriptors,
} from './json-schema-types';
import { generateTypesFromJsonSchema as generateJsonSchemaTypes } from './json-schema-types';
import type { CodeNormalizer } from './normalize';
import { createCodeTool, renderCodeToolDescription, type CreateCodeToolOptions } from './tool';
import type { Executor } from './types';
import type { UnknownRecord } from './type-utils';
import { escapeJsDoc, sanitizeToolName } from './utils';

export interface CreateCodeToolFromModelContextTestingOptions {
  modelContextTesting: Pick<ModelContextTesting, 'listTools' | 'executeTool'>;
  executor: Executor;
  description?: string;
  maxDescriptionLength?: number;
  normalizeCode?: CodeNormalizer;
}

/**
 * Validates that a value looks like a JSON Schema object (has "type" or "properties").
 * This is a boundary check — WebMCP schemas are not guaranteed to be valid JSON Schema.
 */
function isJsonSchemaLike(value: unknown): value is JSONSchema7 {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as UnknownRecord;
  return (
    typeof obj.type === 'string' ||
    typeof obj.properties === 'object' ||
    typeof obj.$ref === 'string' ||
    Array.isArray(obj.anyOf) ||
    Array.isArray(obj.oneOf) ||
    Array.isArray(obj.allOf)
  );
}

/**
 * Convert WebMCP tool list items (from `modelContext.listTools()`)
 * into codemode-compatible JSON Schema tool descriptors.
 */
export function webmcpToolsToCodemode(tools: ToolListItem[]): JsonSchemaToolDescriptors {
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const tool of tools) {
    const inputSchema: JSONSchema7 = isJsonSchemaLike(tool.inputSchema)
      ? tool.inputSchema
      : { type: 'object' };

    const descriptor: JsonSchemaToolDescriptor = { inputSchema };

    if (tool.description !== undefined) {
      descriptor.description = tool.description;
    }
    if (isJsonSchemaLike(tool.outputSchema)) {
      descriptor.outputSchema = tool.outputSchema;
    }

    descriptors[tool.name] = descriptor;
  }
  return descriptors;
}

function parseTestingSchema(serializedSchema?: string): JSONSchema7 {
  if (!serializedSchema) return { type: 'object' };

  try {
    const parsed = JSON.parse(serializedSchema);
    return isJsonSchemaLike(parsed) ? parsed : { type: 'object' };
  } catch {
    return { type: 'object' };
  }
}

function parseTestingResult(serialized: string | null): unknown {
  if (serialized == null) return null;

  try {
    const parsed = JSON.parse(serialized) as
      | {
          structuredContent?: unknown;
          content?: Array<{ type?: string; text?: string }>;
        }
      | unknown;

    if (parsed && typeof parsed === 'object') {
      const toolResponse = parsed as {
        structuredContent?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      };

      if ('structuredContent' in toolResponse && toolResponse.structuredContent != null) {
        return toolResponse.structuredContent;
      }

      if (Array.isArray(toolResponse.content)) {
        const textBlock = toolResponse.content.find((block) => block?.type === 'text');
        if (typeof textBlock?.text === 'string') {
          try {
            return JSON.parse(textBlock.text);
          } catch {
            return textBlock.text;
          }
        }
      }
    }

    return parsed;
  } catch {
    return serialized;
  }
}

function buildCompactTypeBlock(tools: JsonSchemaToolDescriptors, omittedToolCount = 0): string {
  const lines = ['declare const codemode: {'];

  for (const [toolName, descriptor] of Object.entries(tools)) {
    const description = descriptor.description?.trim()
      ? escapeJsDoc(descriptor.description.trim().replace(/\r?\n/g, ' '))
      : escapeJsDoc(toolName);
    lines.push(`  /** ${description} */`);
    lines.push(
      `  ${sanitizeToolName(toolName)}: (input: Record<string, unknown>) => Promise<unknown>;`
    );
  }

  if (omittedToolCount > 0) {
    lines.push(
      `  /** ${omittedToolCount} more tool${omittedToolCount === 1 ? '' : 's'} omitted */`
    );
  }

  lines.push('}');
  return lines.join('\n');
}

function buildLimitedTypeBlock(
  tools: JsonSchemaToolDescriptors,
  descriptionTemplate: string | undefined,
  maxDescriptionLength: number
): string {
  const fitsWithinLimit = (types: string): boolean =>
    renderCodeToolDescription(types, descriptionTemplate).length <= maxDescriptionLength;

  const fullTypes = generateJsonSchemaTypes(tools);
  if (fitsWithinLimit(fullTypes)) {
    return fullTypes;
  }

  const compactTypes = buildCompactTypeBlock(tools);
  if (fitsWithinLimit(compactTypes)) {
    return compactTypes;
  }

  const entries = Object.entries(tools);
  for (let includedCount = entries.length - 1; includedCount >= 0; includedCount--) {
    const includedTools = Object.fromEntries(entries.slice(0, includedCount));
    const candidate = buildCompactTypeBlock(includedTools, entries.length - includedCount);
    if (fitsWithinLimit(candidate)) {
      return candidate;
    }
  }

  return buildCompactTypeBlock({}, entries.length);
}

function buildCreateCodeToolOptions(
  options: CreateCodeToolFromModelContextTestingOptions
): CreateCodeToolOptions {
  const tools = modelContextTestingToCodemodeTools(options.modelContextTesting);
  const createOptions: CreateCodeToolOptions = {
    tools,
    executor: options.executor,
  };

  if (options.maxDescriptionLength !== undefined) {
    const limitedTypes = buildLimitedTypeBlock(
      tools,
      options.description,
      options.maxDescriptionLength
    );
    createOptions.description = renderCodeToolDescription(limitedTypes, options.description);
  } else if (options.description !== undefined) {
    createOptions.description = options.description;
  }

  if (options.normalizeCode !== undefined) {
    createOptions.normalizeCode = options.normalizeCode;
  }

  return createOptions;
}

/**
 * Converts `navigator.modelContextTesting` into codemode-ready JSON Schema tool descriptors
 * with attached execute handlers.
 */
export function modelContextTestingToCodemodeTools(
  modelContextTesting: Pick<ModelContextTesting, 'listTools' | 'executeTool'>
): JsonSchemaExecutableToolDescriptors {
  const listedTools = modelContextTesting.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: parseTestingSchema(tool.inputSchema),
  }));

  const descriptors = webmcpToolsToCodemode(listedTools as unknown as ToolListItem[]);
  const executableTools: JsonSchemaExecutableToolDescriptors = {};

  for (const [name, descriptor] of Object.entries(descriptors)) {
    const executableDescriptor: JsonSchemaExecutableToolDescriptor = {
      ...descriptor,
      execute: async (args: unknown) => {
        const serialized = await modelContextTesting.executeTool(name, JSON.stringify(args ?? {}));
        return parseTestingResult(serialized);
      },
    };

    executableTools[name] = executableDescriptor;
  }

  return executableTools;
}

/**
 * Creates a codemode AI SDK tool directly from `navigator.modelContextTesting`.
 */
export function createCodeToolFromModelContextTesting(
  options: CreateCodeToolFromModelContextTestingOptions
): ReturnType<typeof createCodeTool> {
  const buildCurrentTool = (): ReturnType<typeof createCodeTool> =>
    createCodeTool(buildCreateCodeToolOptions(options));
  const liveTool = buildCurrentTool();

  Object.defineProperty(liveTool, 'description', {
    configurable: true,
    enumerable: true,
    get: () => buildCurrentTool().description,
  });

  liveTool.execute = (...args: Parameters<NonNullable<(typeof liveTool)['execute']>>) => {
    const execute = buildCurrentTool().execute;
    if (!execute) {
      throw new Error('Codemode tool execute handler is unavailable');
    }
    return execute(...args);
  };

  return liveTool;
}
