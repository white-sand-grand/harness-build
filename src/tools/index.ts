import { createReadTool } from './read.ts';
import { createWriteTool } from './write.ts';
import { createEditTool } from './edit.ts';
import { createBashTool } from './bash.ts';
export { createReadTool, createWriteTool, createEditTool, createBashTool };
export const createDefaultTools = (descriptions: Record<string, string>) => [
  createReadTool(descriptions.read ?? ''),
  createWriteTool(descriptions.write ?? ''),
  createEditTool(descriptions.edit ?? ''),
  createBashTool(descriptions.bash ?? ''),
];
