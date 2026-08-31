/** Every tool, in the order they appear in the README. */

import type { AnyToolSpec } from "./kit.js";

import { accountTools } from "./accounts.js";
import { postTools } from "./posts.js";
import { engageTools } from "./engage.js";
import { readTools } from "./read.js";
import { discoverTools } from "./discover.js";
import { graphTools } from "./graph.js";
import { notificationTools } from "./notifications.js";

export const ALL_TOOLS: AnyToolSpec[] = [
  ...accountTools,
  ...postTools,
  ...engageTools,
  ...readTools,
  ...discoverTools,
  ...graphTools,
  ...notificationTools,
];
