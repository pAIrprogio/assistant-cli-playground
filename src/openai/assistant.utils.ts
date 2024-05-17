import { Tool, toOpenAiTools } from "./tools.utils.js";

export interface AssistantConfig<T extends Array<Tool> = Array<Tool<any>>> {
  name: string;
  model: "gpt-4-turbo-preview" | "gpt-3.5-turbo" | "gpt-4o";
  description: string;
  instructions: string;
  tools: T;
}

export function serializeAssistantConfig(assistantConfig: AssistantConfig) {
  return {
    ...assistantConfig,
    tools: toOpenAiTools(assistantConfig.tools),
  };
}

export type SerializedAssistantConfig = ReturnType<
  typeof serializeAssistantConfig
>;
