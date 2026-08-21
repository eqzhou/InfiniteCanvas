export type WorkflowVariable =
  | { id: string; kind: "text" | "textarea"; label: string; required: boolean; default?: string }
  | { id: string; kind: "select"; label: string; required: boolean; options: string[]; default?: string }
  | { id: string; kind: "number"; label: string; required: boolean; min: number; max: number; default?: number }
  | { id: string; kind: "boolean"; label: string; default: boolean }
  | { id: string; kind: "image"; label: string; required: boolean };

export type WorkflowStepReference =
  | { source: "variable"; variableId: string }
  | { source: "step"; stepId: string; output: "all" | number };

export type WorkflowStep = {
  id: string;
  title: string;
  promptTemplate: string;
  providerId: string;
  model?: string;
  parameters: {
    size: string;
    quality?: string;
    resolution?: string;
    count: number;
    transparentBackground?: boolean;
  };
  references: WorkflowStepReference[];
};

export type WorkflowTemplate = {
  schemaVersion: 1;
  id: string;
  revision: number;
  scope: "public" | "personal";
  title: string;
  description: string;
  category: string;
  variables: WorkflowVariable[];
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
};

export type WorkflowValue = string | number | boolean | string[];
export type WorkflowValues = Record<string, WorkflowValue>;

export type WorkflowStepRunState = {
  status: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  childJobId?: string;
  childJobIds?: string[];
  storageKeys?: string[];
  error?: string;
};

export type WorkflowRunParameters = {
  executor: "workflow";
  requestHash: string;
  templateId: string;
  templateRevision: number;
  templateSnapshot: WorkflowTemplate;
  values: WorkflowValues;
};

export type WorkflowRunResult = {
  steps: Record<string, WorkflowStepRunState>;
  outputStorageKeys: string[];
};
