import type { z } from "zod";
export type RegisterTool = <T extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: T,
  fn: (args: z.infer<z.ZodObject<T>>) => unknown,
  appOnly?: boolean,
) => void;
