import { map, toArray, zip } from "iter-tools";
import OpenAI from "openai";
import { AssistantConfig } from "./assistant.utils.js";
import {
  ErrorToolOutput,
  Tool,
  toOpenAiTools,
  toToolsMap,
} from "./tool.utils.js";

type PromiseValue<T> = T extends Promise<infer U> ? U : never;
type AsyncGeneratorValue<T> = T extends AsyncGenerator<infer U, any, any>
  ? U
  : never;

const defaultErrorFormater = (error: any): ErrorToolOutput => {
  if (typeof error === "string") return { success: false as const, error };
  if (error instanceof Error)
    return { success: false as const, error: error.message };

  return { success: false as const, error: JSON.stringify(error) };
};

type ErrorFormaterFn = typeof defaultErrorFormater;

export type Config = {
  openAIClient: OpenAI;
  errorFormater?: ErrorFormaterFn;
};

export const createAssistant = async <T extends Array<Tool>>(
  assistantConfig: AssistantConfig<T>,
  config: Config,
) => {
  const openAIClient = config.openAIClient;
  const systemPrompt = assistantConfig.systemPrompt;
  const toolsSchema = toOpenAiTools(assistantConfig.tools);
  const toolsMap = toToolsMap(assistantConfig.tools);
  const errorFormater = config.errorFormater ?? defaultErrorFormater;

  const openAIAssistant = await openAIClient.beta.assistants.create({
    name: "pAIprog",
    model: "gpt-4-1106-preview",
    instructions: systemPrompt,
    tools: toolsSchema,
  });

  const executeFunctions = async (run: OpenAI.Beta.Threads.Runs.Run) => {
    if (!run.required_action) {
      throw new Error("Empty tool function to execute");
    }

    if (run.required_action.type !== "submit_tool_outputs") {
      throw new Error("Unsupported tool function, check your schema");
    }

    const toolCalls = run.required_action.submit_tool_outputs.tool_calls;

    const outputPromises = toolCalls.map((toolCall) => {
      if (toolCall.type !== "function") {
        return {
          success: false,
          error: "Unsupported tool call type",
        } as ErrorToolOutput;
      }

      const functionName = toolCall.function.name as keyof typeof toolsSchema;

      const tool = toolsMap[functionName as string];

      if (!tool)
        return {
          success: false,
          error: `Unsupported tool function ${functionName as string}`,
        } as ErrorToolOutput;

      const functionArguments = tool.argsSchema.safeParse(
        JSON.parse(toolCall.function.arguments),
      );

      if (!functionArguments.success) {
        return {
          success: false,
          error: `Invalid arguments for function ${functionName as string}`,
          argErrors: functionArguments.error.format(),
        } as ErrorToolOutput;
      }

      const output = tool.call(functionArguments.data).catch(errorFormater);

      return output;
    });

    const allOutputsPromise = Promise.all(outputPromises);

    const outputs = await allOutputsPromise;

    const toolsOutput = map(
      ([toolCall, output]) => {
        return {
          tool_call_id: toolCall.id,
          output,
        };
      },
      zip(toolCalls, outputs),
    );

    const isSuccess = outputs.every((output) => output.success === true);

    return [toArray(toolsOutput), isSuccess] as const;
  };

  return {
    openAIAssistant,
    executeFunctions,
  };
};

export type Assistant = PromiseValue<ReturnType<typeof createAssistant>>;

export type ThreadConfig = {
  openAIClient: OpenAI;
  assistant: Assistant;
  pollingInterval?: number;
};

export interface ToolCall {
  id: string;
  name: string;
  args: any;
}

export async function createThread(config: ThreadConfig) {
  const {
    assistant: defaultAssistant,
    openAIClient,
    pollingInterval = 500,
  } = config;

  const openAIThread = await openAIClient.beta.threads.create({});
  let currentCancel = async () => {};

  /**
   * Cancel the current run
   */
  const cancel = () => currentCancel();

  /**
   * Send a new message to the thread
   */
  async function* sendMessage(text: string, assistant?: Assistant) {
    let run: OpenAI.Beta.Threads.Runs.Run;
    let isInterrupted = false;

    currentCancel = async () => {
      isInterrupted = true;
      if (!run) return;
      await openAIClient.beta.threads.runs
        .cancel(openAIThread.id, run.id)
        .catch(() => {
          // Ignore error when trying to cancel a cancelled or completed run
        });
    };

    const message = await openAIClient.beta.threads.messages.create(
      openAIThread.id,
      {
        role: "user",
        content: text,
      },
    );

    yield {
      type: "message_sent" as const,
      id: message.id,
      content: text,
    };

    const runAssistant = assistant ?? defaultAssistant;

    run = await openAIClient.beta.threads.runs.create(openAIThread.id, {
      assistant_id: runAssistant.openAIAssistant.id,
    });

    while (true) {
      if (
        run.status === "queued" ||
        run.status === "in_progress" ||
        run.status === "cancelling"
      ) {
        await new Promise((resolve) => setTimeout(resolve, pollingInterval));
        yield { type: run.status };
        run = await openAIClient.beta.threads.runs.retrieve(
          openAIThread.id,
          run.id,
        );
        continue;
      }

      if (run.status === "cancelled") {
        yield { type: "cancelled" as const };
        return;
      }

      if (run.status === "failed") {
        yield {
          type: "failed" as const,
          error: run.last_error?.message ?? "Unknown Error",
        };
        return;
      }

      if (run.status === "expired") {
        yield { type: "expired" as const };
        return;
      }

      if (run.status === "requires_action") {
        const tools = run.required_action?.submit_tool_outputs.tool_calls ?? [];

        const mappedTools = tools.map((tool) => ({
          id: tool.id,
          name: tool.function.name,
          args: JSON.parse(tool.function.arguments),
        })) satisfies ToolCall[];

        yield { type: "executing_tools" as const, tools: mappedTools };

        try {
          const [toolOutputs, isSuccess] =
            await runAssistant.executeFunctions(run);

          const newRun = await openAIClient.beta.threads.runs.submitToolOutputs(
            openAIThread.id,
            run.id,
            {
              tool_outputs: toolOutputs.map((tool) => ({
                tool_call_id: tool.tool_call_id,
                output: JSON.stringify(tool.output),
              })),
            },
          );

          const mappedToolsWithOutput = mappedTools.map((tool, index) => ({
            ...tool,
            isSuccess: toolOutputs[index].output.success,
            output: toolOutputs[index].output.output,
            error: toolOutputs[index].output.error,
          }));

          yield {
            type: "executing_tools_done" as const,
            isSuccess,
            tools: mappedToolsWithOutput,
          };

          run = newRun;
        } catch (error) {
          // Recover from error when trying to send tool outputs on a cancelled run
          if (isInterrupted) continue;
          throw error;
        }
      }

      if (run.status === "completed") {
        const messages = await openAIClient.beta.threads.messages.list(
          openAIThread.id,
        );

        const lastMessage = messages.data[0].content[0];

        if (lastMessage.type === "text") {
          // TODO: add annotations
          yield {
            type: "completed" as const,
            message: lastMessage.text.value,
            id: messages.data[0].id,
          };
          return;
        }
      }
    }
  }

  return {
    openAIThread,
    sendMessage,
    cancel,
  };
}

export type Thread = PromiseValue<ReturnType<typeof createThread>>;

export type Message = AsyncGeneratorValue<ReturnType<Thread["sendMessage"]>>;
