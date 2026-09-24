import type { BuilderService } from "@enterprise-brain/builder";
import type { Platform } from "@enterprise-brain/runtime";
import type { ServerConfig } from "./config.ts";

export interface AppContext {
  platform: Platform;
  builder: BuilderService;
  config: ServerConfig;
}
