import { describe, expect, it } from 'vitest';
import {
  createCodeToolFromModelContextTesting,
  modelContextTestingToCodemodeTools,
} from '../webmcp';

describe('modelContextTestingToCodemodeTools', () => {
  it('converts listed tools into executable codemode descriptors', async () => {
    const modelContextTesting = {
      listTools: () => [
        {
          name: 'sum',
          description: 'Add two numbers',
          inputSchema: JSON.stringify({
            type: 'object',
            properties: {
              a: { type: 'number', description: 'First number' },
              b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
          }),
        },
      ],
      executeTool: async (toolName: string, inputArgsJson: string) => {
        const args = JSON.parse(inputArgsJson) as { a: number; b: number };
        return JSON.stringify({
          toolName,
          total: args.a + args.b,
        });
      },
    };

    const tools = modelContextTestingToCodemodeTools(modelContextTesting);
    const result = await tools.sum?.execute?.({ a: 2, b: 3 });

    expect(tools.sum?.description).toBe('Add two numbers');
    expect(tools.sum?.inputSchema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    });
    expect(result).toEqual({
      toolName: 'sum',
      total: 5,
    });
  });

  it('falls back to an object schema when testing inputSchema is missing or invalid', () => {
    const tools = modelContextTestingToCodemodeTools({
      listTools: () => [
        { name: 'missing', description: 'Missing schema', inputSchema: '' },
        { name: 'invalid', description: 'Invalid schema', inputSchema: '{not-json' },
      ],
      executeTool: async () => null,
    });

    expect(tools.missing?.inputSchema).toEqual({ type: 'object' });
    expect(tools.invalid?.inputSchema).toEqual({ type: 'object' });
  });

  it('returns raw strings when testing execution returns non-JSON content', async () => {
    const tools = modelContextTestingToCodemodeTools({
      listTools: () => [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: JSON.stringify({ type: 'object' }),
        },
      ],
      executeTool: async () => 'plain text result',
    });

    await expect(tools.echo?.execute?.({ message: 'hello' })).resolves.toBe('plain text result');
  });

  it('unwraps structuredContent from the serialized ToolResponse shape', async () => {
    const tools = modelContextTestingToCodemodeTools({
      listTools: () => [
        {
          name: 'getData',
          description: 'Get data',
          inputSchema: JSON.stringify({ type: 'object' }),
        },
      ],
      executeTool: async () =>
        JSON.stringify({
          content: [{ type: 'text', text: '{"items":[1,2,3]}' }],
          structuredContent: { items: [1, 2, 3] },
          isError: false,
        }),
    });

    await expect(tools.getData?.execute?.({})).resolves.toEqual({ items: [1, 2, 3] });
  });

  it('falls back to text content when structuredContent is missing', async () => {
    const tools = modelContextTestingToCodemodeTools({
      listTools: () => [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: JSON.stringify({ type: 'object' }),
        },
      ],
      executeTool: async () =>
        JSON.stringify({
          content: [{ type: 'text', text: 'hello world' }],
          isError: false,
        }),
    });

    await expect(tools.echo?.execute?.({})).resolves.toBe('hello world');
  });
});

describe('createCodeToolFromModelContextTesting', () => {
  it('creates a codemode tool that executes through modelContextTesting', async () => {
    const codemode = createCodeToolFromModelContextTesting({
      modelContextTesting: {
        listTools: () => [
          {
            name: 'sum',
            description: 'Add two numbers',
            inputSchema: JSON.stringify({
              type: 'object',
              properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
              },
              required: ['a', 'b'],
            }),
          },
        ],
        executeTool: async (_toolName: string, inputArgsJson: string) => {
          const args = JSON.parse(inputArgsJson) as { a: number; b: number };
          return JSON.stringify(args.a + args.b);
        },
      },
      executor: {
        execute: async (_code, fns) => ({
          result: await fns.sum?.({ a: 4, b: 5 }),
          logs: [],
        }),
      },
    });

    expect((codemode as { description?: string }).description).toContain('type SumInput = {');
    expect((codemode as { description?: string }).description).toContain(
      '@param input.a - First number'
    );

    const result = await (
      codemode as { execute: (input: { code: string }) => Promise<unknown> }
    ).execute({
      code: 'async () => { return await codemode.sum({ a: 4, b: 5 }); }',
    });

    expect(result).toEqual({
      code: 'async () => { return await codemode.sum({ a: 4, b: 5 }); }',
      result: 9,
      logs: [],
    });
  });

  it('sees tools registered after construction on execute', async () => {
    const listedTools: Array<{ name: string; description: string; inputSchema: string }> = [];

    const codemode = createCodeToolFromModelContextTesting({
      modelContextTesting: {
        listTools: () => [...listedTools],
        executeTool: async (_toolName: string, inputArgsJson: string) => {
          const args = JSON.parse(inputArgsJson) as { a: number; b: number };
          return JSON.stringify(args.a + args.b);
        },
      },
      executor: {
        execute: async (_code, fns) => ({
          result: await fns.sum?.({ a: 1, b: 2 }),
          logs: [],
        }),
      },
    });

    listedTools.push({
      name: 'sum',
      description: 'Add numbers',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      }),
    });

    await expect(
      (codemode as { execute: (input: { code: string }) => Promise<unknown> }).execute({
        code: 'async () => { return await codemode.sum({ a: 1, b: 2 }); }',
      })
    ).resolves.toEqual({
      code: 'async () => { return await codemode.sum({ a: 1, b: 2 }); }',
      result: 3,
      logs: [],
    });
  });

  it('updates description from the latest listed tools', () => {
    const listedTools: Array<{ name: string; description: string; inputSchema: string }> = [];

    const codemode = createCodeToolFromModelContextTesting({
      modelContextTesting: {
        listTools: () => [...listedTools],
        executeTool: async () => null,
      },
      executor: {
        execute: async () => ({
          result: null,
          logs: [],
        }),
      },
    });

    expect((codemode as { description: string }).description).not.toContain('sum:');

    listedTools.push({
      name: 'sum',
      description: 'Add numbers',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
      }),
    });

    expect((codemode as { description: string }).description).toContain('type SumInput = {');
    expect((codemode as { description: string }).description).toContain('sum: (input: SumInput)');
  });

  it('caps generated descriptions when maxDescriptionLength is set', () => {
    const listedTools = Array.from({ length: 6 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index} with a very long description that would otherwise bloat the codemode prompt`,
      inputSchema: JSON.stringify({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'A long field description that makes the generated type block grow quickly across many tools',
          },
        },
      }),
    }));

    const codemode = createCodeToolFromModelContextTesting({
      modelContextTesting: {
        listTools: () => listedTools,
        executeTool: async () => null,
      },
      executor: {
        execute: async () => ({
          result: null,
          logs: [],
        }),
      },
      maxDescriptionLength: 650,
    });

    const description = (codemode as { description: string }).description;

    expect(description.length).toBeLessThanOrEqual(650);
    expect(description).toContain('declare const codemode: {');
    expect(description).toContain('tool_0: (input: Record<string, unknown>) => Promise<unknown>;');
    expect(description).toContain('omitted');
    expect(description).not.toContain('type Tool0Input = {');
  });
});
