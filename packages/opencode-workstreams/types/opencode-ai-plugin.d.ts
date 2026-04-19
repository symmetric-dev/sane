declare module "@opencode-ai/plugin" {
  interface SchemaBuilder {
    describe(description: string): SchemaBuilder
    optional(): SchemaBuilder
  }

  interface ToolFactory {
    <Args extends Record<string, unknown>, Result>(definition: {
      description: string
      args: Args
      execute: (args: any, context: { sessionID?: string }) => Result | Promise<Result>
    }): {
      description: string
      args: Args
      execute: (args: any, context: { sessionID?: string }) => Result | Promise<Result>
    }
    schema: {
      string(): SchemaBuilder
      boolean(): SchemaBuilder
      number(): SchemaBuilder
    }
  }

  export const tool: ToolFactory
}
