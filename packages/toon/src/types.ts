export interface ToolCommandDef {
  name: string;
  shortDescription: string;
}

export interface ToolDef {
  name: string;
  shortDescription: string;
  pinned?: boolean;
  important?: boolean;
  commands: ToolCommandDef[];
}

export interface PromptOptions {
  runKind: string;
  locale?: string;
}
