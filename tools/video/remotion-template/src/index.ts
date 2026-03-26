/**
 * Remotion entry point.
 *
 * This file is the bundler entry — it registers the Root component which
 * in turn declares all compositions.
 */

import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
