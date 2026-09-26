import type { BuilderService } from "@enterprise-brain/builder";
import type { Platform } from "@enterprise-brain/runtime";
import type { AuthService } from "./auth/service.ts";
import type { ServerConfig } from "./config.ts";
import type { StudioService } from "./studio/service.ts";

export interface AppContext {
  platform: Platform;
  builder: BuilderService;
  config: ServerConfig;
  /** Sign-in and sessions; buildServer creates it when not given (tests pass one with a fake provider). */
  auth?: AuthService;
  /** The Studio agent's conversations; buildServer creates it when not given. */
  studio?: StudioService;
}
