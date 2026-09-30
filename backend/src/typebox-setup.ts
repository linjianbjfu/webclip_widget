/**
 * Disable TypeBox's accelerated validator.
 *
 * pi compiles tool-argument schemas with `Compile()`, which goes through
 * `new Function`. Workers refuse that with "Code generation from strings
 * disallowed for this context", and the failure surfaces as every tool call
 * erroring rather than as anything pointing at TypeBox. This module must be
 * evaluated before any pi module is imported.
 */

import { Settings } from "typebox/system";

Settings.Set({ useAcceleration: false });
