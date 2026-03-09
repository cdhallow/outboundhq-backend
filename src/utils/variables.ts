interface ContactVariables {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  email?: string | null;
  [key: string]: string | null | undefined;
}

/**
 * Replace template variables in a string with contact field values.
 *
 * Supported variables:
 *   {{firstName}}  → contact.first_name
 *   {{lastName}}   → contact.last_name
 *   {{company}}    → contact.company
 *   {{email}}      → contact.email
 *
 * Unknown variables are left as-is so nothing is accidentally blanked out.
 */
export function replaceVariables(template: string, contact: ContactVariables): string {
  if (!template) return template;

  const variableMap: Record<string, string> = {
    firstName: contact.first_name ?? '',
    lastName:  contact.last_name  ?? '',
    company:   contact.company    ?? '',
    email:     contact.email      ?? '',
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in variableMap ? variableMap[key] : match;
  });
}
