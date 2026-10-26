/**
 * Policy templates shipped as YAML in this package's `templates/` folder
 * (docs/SPEC.md section 5.5). Every one starts with `mode: monitor`. Read
 * them from `@posterna/core/templates/<name>.yaml`.
 */
export const TEMPLATE_NAMES = ["monitor", "allow-list", "saas-signup"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];
